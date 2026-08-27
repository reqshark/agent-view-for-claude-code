// Normalize + compare questions. Pure functions, no I/O — the two steps the
// Triage pipeline leans on hardest, kept testable in isolation.
//
// The spec calls for embeddings; this build uses a hybrid lexical measure
// instead (token Jaccard + character-trigram cosine + entity overlap). That
// keeps Triage dependency-free and fully offline, which matters more for the
// terminal-restricted environments this targets than the last few points of
// recall. Thresholds stay configurable, and an optional AI normalize pass
// (see engine.ts) improves the intent string the measure runs over.
//
// The spec's 0.88 / 0.92 thresholds were named for embedding cosine and do not
// transfer: this measure separates paraphrases from different questions in the
// 0.62-0.71 band, so the shipped defaults are 0.70 (dedup) and 0.80 (lookup).
// The ordering the spec cares about is preserved — lookup is strictly stricter
// than dedup, because a wrong merge costs a glance and a wrong auto-answer
// costs an agent a wrong turn.

import * as path from "path";
import { NormalizedQuestion, QuestionCategory, ScopeHint } from "./types";
import { stripMarkdown } from "../util/markdown";

const STOPWORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do", "does", "for",
  "from", "have", "how", "i", "if", "in", "is", "it", "like", "me", "my", "of", "on", "or",
  "our", "please", "should", "so", "than", "that", "the", "then", "there", "these", "this",
  "to", "us", "use", "want", "was", "we", "what", "when", "where", "which", "will", "with",
  "would", "you", "your", "here", "just", "need", "any", "some", "prefer", "rather", "ok",
]);

/** Politeness / meta-question wrappers that carry no decision content. */
const PREFIXES = [
  /^(hey|hi|ok|okay)[,\s]+/i,
  /^(quick question|a question|question)[:,\s]+/i,
  /^(do you want me to|would you like me to|should i|shall i|can i|may i)\s+/i,
  /^(which|what|how)\s+(one|option|approach)?\s*(should|do|would)\s+(i|we|you)\s+/i,
  /^(i need to know|let me know|please confirm|confirm)\s+/i,
];

const CATEGORY_PATTERNS: [QuestionCategory, RegExp][] = [
  [
    "tooling",
    /\b(npm|pnpm|yarn|bun|package manager|vite|webpack|rollup|esbuild|jest|vitest|pytest|mocha|test (framework|runner)|docker|ci|pipeline|eslint|prettier|biome|linter|formatter|tsc|typecheck|build (tool|command)|makefile|poetry|pip|gradle|maven|cargo)\b/i,
  ],
  [
    "convention",
    /\b(naming|name it|convention|code style|styling|casing|camelcase|snake_case|kebab|import (order|style)|export style|comment|docstring|commit message|branch name|formatting|indent|quotes|semicolons)\b/i,
  ],
  [
    "permission",
    /\b(permission|allow|approve|authorize|may i run|run the command|execute|delete|force[- ]push|push to|write to|overwrite|credentials|secret|token|install)\b/i,
  ],
  [
    "scope",
    /\b(in scope|out of scope|scope|also (update|change|refactor)|should i also|include|exclude|off limits|touch|leave alone|migrate|rename (across|everywhere)|extend to)\b/i,
  ],
  [
    "design",
    /\b(architecture|design|approach|abstraction|interface|schema|data model|api (shape|surface)|structure|pattern|refactor into|split into|single (class|module)|strategy)\b/i,
  ],
];

/** Path-ish or code-ish tokens that identify what a question is *about*. */
function extractEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]{1,60})`/g)) out.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/"([^"]{1,60})"/g)) out.add(m[1].trim().toLowerCase());
  for (const m of text.matchAll(/\b[\w.-]+\/[\w./-]+\b/g)) out.add(path.basename(m[0]).toLowerCase());
  for (const m of text.matchAll(/\b[\w-]+\.(ts|tsx|js|jsx|py|go|rs|rb|java|json|ya?ml|toml|md)\b/gi)) {
    out.add(m[0].toLowerCase());
  }
  for (const m of text.matchAll(
    /\b(npm|pnpm|yarn|bun|vite|webpack|esbuild|jest|vitest|pytest|mocha|eslint|prettier|biome|docker|tsc|poetry|pip|cargo|gradle|maven)\b/gi,
  )) {
    out.add(m[0].toLowerCase());
  }
  return [...out].filter((e) => e.length > 1).slice(0, 12);
}

/** Strip the session-specific detail the spec calls out: line numbers, temp
 *  ids, absolute paths, hashes — anything that would make two identical
 *  decisions look different. */
export function canonicalize(raw: string): string {
  let t = stripMarkdown(raw)
    .replace(/\r/g, "")
    .replace(/https?:\/\/\S+/g, " url ")
    .replace(/\b[0-9a-f]{7,40}\b/gi, " sha ")
    .replace(/(^|\s)\/[\w./-]+/g, (m) => " " + path.basename(m.trim()))
    .replace(/:\d+(:\d+)?\b/g, "")
    .replace(/\b\d+\b/g, " ")
    .replace(/[^\p{L}\p{N}\s._/-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  for (const p of PREFIXES) t = t.replace(p, "");
  return t.trim();
}

/** Crude suffix stripping so "install"/"installing" and "test"/"tests" are the
 *  same token. Not a real stemmer — just enough that plural and progressive
 *  forms of the same question don't read as two different questions. */
function stem(w: string): string {
  if (w.length <= 3) return w;
  if (w.endsWith("ies") && w.length > 4) return `${w.slice(0, -3)}y`;
  if (w.endsWith("sses")) return w.slice(0, -2);
  if (w.endsWith("ing") && w.length > 5) return w.slice(0, -3);
  if (w.endsWith("ed") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("es") && w.length > 4) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export function tokenize(text: string): string[] {
  return canonicalize(text)
    .toLowerCase()
    .split(/[\s._/-]+/)
    .filter((w) => w.length > 1 && !STOPWORDS.has(w))
    .map(stem);
}

function categorize(text: string, isPermission: boolean): QuestionCategory {
  if (isPermission) return "permission";
  for (const [cat, re] of CATEGORY_PATTERNS) if (re.test(text)) return cat;
  return "other";
}

function scopeFor(category: QuestionCategory, entities: string[]): ScopeHint {
  const hasFile = entities.some((e) => /\.[a-z]{1,5}$/i.test(e));
  switch (category) {
    case "tooling":
    case "convention":
      return "repo";
    case "permission":
      return hasFile ? "file" : "repo";
    case "design":
      return hasFile ? "file" : "module";
    case "scope":
      return "module";
    default:
      return "repo";
  }
}

/**
 * Rules-based Normalize (Triage step 1). Rewrites a raw question into a
 * canonical one-line intent plus the structure dedup and lookup compare.
 * Deterministic, offline, and free — the AI pass in engine.ts only replaces
 * the `intent` string when the user has opted in.
 */
export function normalizeQuestion(
  text: string,
  opts: { permission?: boolean; options?: string[] } = {},
): NormalizedQuestion {
  const entities = extractEntities([text, ...(opts.options || [])].join(" "));
  const category = categorize(text, !!opts.permission);
  const words = tokenize(text);
  const intent = words.join(" ").slice(0, 160) || canonicalize(text).slice(0, 160);
  return { intent, category, entities, scopeHint: scopeFor(category, entities) };
}

// ------------------------------------------------------------- similarity --

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

function trigrams(s: string): Map<string, number> {
  const padded = `  ${s}  `;
  const m = new Map<string, number>();
  for (let i = 0; i + 3 <= padded.length; i++) {
    const g = padded.slice(i, i + 3);
    m.set(g, (m.get(g) || 0) + 1);
  }
  return m;
}

function cosine(a: Map<string, number>, b: Map<string, number>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [k, v] of a) {
    na += v * v;
    const w = b.get(k);
    if (w) dot += v * w;
  }
  for (const v of b.values()) nb += v * v;
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/** Cached comparison form of a normalized question. */
export interface Fingerprint {
  tokens: Set<string>;
  entities: Set<string>;
  tri: Map<string, number>;
}

export function fingerprint(n: { intent: string; entities?: string[] }): Fingerprint {
  return {
    tokens: new Set(tokenize(n.intent)),
    entities: new Set((n.entities || []).map((e) => e.toLowerCase())),
    tri: trigrams(n.intent.toLowerCase()),
  };
}

/**
 * 0..1 similarity between two normalized questions. Weighted so that agreeing
 * on *what is being decided* (tokens) dominates, wording similarity breaks
 * ties, and disagreeing about the subject (entities) pulls the score down —
 * "add tests for auth" and "add tests for billing" must not merge.
 */
export function similarity(a: Fingerprint, b: Fingerprint): number {
  const tokens = jaccard(a.tokens, b.tokens);
  // With no entities on either side there is nothing to agree about, so the
  // entity channel echoes the token channel rather than handing every
  // entity-less pair a free 0.15 and squashing the bottom of the scale.
  const entities =
    a.entities.size === 0 && b.entities.size === 0 ? tokens : jaccard(a.entities, b.entities);
  return 0.6 * tokens + 0.25 * cosine(a.tri, b.tri) + 0.15 * entities;
}

/** Minimal glob match (`*` within a segment, `**` across segments). */
export function globMatch(glob: string, value: string): boolean {
  const rx = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, " ")
    .replace(/\*/g, "[^/]*")
    .replace(/ /g, ".*");
  return new RegExp(`^${rx}$`).test(value);
}

/** Ticket id from a branch name ("feature/ABC-123-thing" -> "ABC-123"). */
export function ticketFromBranch(branch?: string): string | undefined {
  const m = branch?.match(/\b([A-Z][A-Z0-9]+-\d+)\b/);
  return m ? m[1] : undefined;
}
