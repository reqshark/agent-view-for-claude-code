// Claude-backed adjudication for the two judgment calls Triage actually cares
// about: "are these two agents asking the same thing?" and "does this standing
// decision already answer that?".
//
// Why a model and not just the lexical measure in text.ts: Claude Code is a
// hard requirement of this extension, so `claude -p` is always on hand, and
// these are semantic questions token overlap cannot answer — "install deps" and
// "install dependencies" are the same decision; "tests for auth" and "tests for
// billing" are not. The lexical measure stays as the *prefilter* (it decides
// which pairs are even worth a call) and as the offline fallback.
//
// Cost is bounded by construction: a call only happens when a NEW question
// arrives, which only happens when an agent is already blocked on the human.
// The human is waiting anyway, so latency is free and a Haiku-class call is
// negligible next to the stalled agent.

import { runClaude, extractJson } from "../llm/runner";
import { stripMarkdown } from "../util/markdown";
import { QuestionCategory } from "./types";

export interface JudgeOptions {
  claudePath: string;
  model: string;
  timeoutMs?: number;
}

/** At most this many model calls in flight; the rest queue. */
const MAX_CONCURRENT = 2;

let inFlight = 0;
const queue: (() => void)[] = [];

function acquire(): Promise<void> {
  if (inFlight < MAX_CONCURRENT) {
    inFlight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => queue.push(resolve));
}

function release(): void {
  const next = queue.shift();
  if (next) next();
  else inFlight--;
}

async function ask<T>(prompt: string, opts: JudgeOptions): Promise<T | null> {
  await acquire();
  try {
    const raw = await runClaude(prompt, {
      claudePath: opts.claudePath,
      model: opts.model,
      timeoutMs: opts.timeoutMs ?? 45_000,
    });
    return extractJson<T>(raw);
  } catch {
    return null; // offline, no auth, timeout — callers fall back to lexical
  } finally {
    release();
  }
}

export interface SameVerdict {
  same: boolean;
  why: string;
}

/**
 * Would one answer satisfy both questions? Used to decide whether two sessions
 * join one Inbox row. A false negative costs the human one extra glance, so the
 * prompt is told to prefer "no" when unsure.
 */
export async function judgeSameQuestion(
  a: string,
  b: string,
  opts: JudgeOptions,
): Promise<SameVerdict | null> {
  const prompt =
    `Two coding agents each stopped to ask their supervisor a question. Decide whether they are ` +
    `asking for the SAME decision — whether one answer from the supervisor would satisfy both.\n\n` +
    `The only test is whether ONE answer from the supervisor would satisfy both agents. Grammatical ` +
    `form is irrelevant: "which should I use", "what do we use here", and "is X ok?" about the same ` +
    `choice are all the SAME decision, because naming the choice answers all of them.\n` +
    `NOT the same decision: a different subject (auth vs billing), a different file, module or ` +
    `ecosystem, a different set of options, or one asks about a specific case the other's answer ` +
    `would not settle.\n` +
    `If you are genuinely unsure, answer false — merging two different questions is worse than ` +
    `showing two rows.\n\n` +
    `Return ONLY JSON, no prose or fences: {"same": true|false, "why": "at most 12 words"}\n\n` +
    `Question A:\n${a.slice(0, 1200)}\n\nQuestion B:\n${b.slice(0, 1200)}`;

  const parsed = await ask<{ same?: unknown; why?: unknown }>(prompt, opts);
  if (!parsed || typeof parsed.same !== "boolean") return null;
  return { same: parsed.same, why: stripMarkdown(String(parsed.why || "")).slice(0, 80) };
}

export interface AppliesVerdict {
  answers: boolean;
  why: string;
}

/**
 * Does a standing decision already answer this question? This is the gate in
 * front of every auto-answer, so the prompt is deliberately strict: partial
 * coverage, a different subject, or any doubt must come back false.
 *
 * Deliberately NOT given the decision's scope. Whether the decision applies to
 * this repo, branch and path is a hard filter the engine has already run before
 * calling here; handing the model that context only invites it to re-litigate a
 * check that passed — and it has no way to know the new question came from the
 * same place. The model judges content, the engine judges scope.
 *
 * The model only ever returns a yes/no. The text handed to the agent is the
 * human's recorded answer, verbatim — so what the Decisions tab shows is exactly
 * what the agent was told, which is what makes an auto-answer auditable.
 */
export async function judgeDecisionApplies(
  question: string,
  decision: { intent: string; answer: string },
  opts: JudgeOptions,
): Promise<AppliesVerdict | null> {
  const prompt =
    `A developer supervising several coding agents previously recorded a standing decision for ` +
    `their codebase. A different agent working in the SAME codebase has now asked a question. ` +
    `Decide whether the standing decision ALREADY answers it, well enough that the developer would ` +
    `not want to be asked again.\n\n` +
    `Judge the content only. The decision is already known to apply to this agent's repository and ` +
    `branch — do not second-guess that.\n\n` +
    `Answer true only if the recorded answer is unambiguous and complete for this exact question. ` +
    `Answer false if it is about a different subject, only partially covers the question, leaves the ` +
    `agent needing a follow-up, or you are unsure. A wrong "true" sends an agent down the wrong path ` +
    `without the developer seeing it; a wrong "false" merely asks them once more.\n\n` +
    `Return ONLY JSON, no prose or fences: {"answers": true|false, "why": "at most 12 words"}\n\n` +
    `Standing decision\n` +
    `  question it answered: ${decision.intent.slice(0, 400)}\n` +
    `  the developer's answer: ${decision.answer.slice(0, 800)}\n\n` +
    `New question from an agent:\n${question.slice(0, 1200)}`;

  const parsed = await ask<{ answers?: unknown; why?: unknown }>(prompt, opts);
  if (!parsed || typeof parsed.answers !== "boolean") return null;
  return { answers: parsed.answers, why: stripMarkdown(String(parsed.why || "")).slice(0, 80) };
}

export interface NormalizeVerdict {
  intent: string;
  category?: QuestionCategory;
  entities?: string[];
}

/** Restate a raw question as the decision it is asking for (spec step 1). */
export async function judgeNormalize(
  text: string,
  opts: JudgeOptions,
): Promise<NormalizeVerdict | null> {
  const prompt =
    `Restate a coding agent's question as the decision it is really asking for, stripped of ` +
    `session-specific detail (line numbers, temp names, absolute paths).\n` +
    `Return ONLY JSON, no prose or fences:\n` +
    `{"intent":"one lowercase sentence naming the decision","category":"tooling|convention|scope|permission|design|other","entities":["concrete nouns the decision is about"]}\n\n` +
    `Question:\n${text.slice(0, 1500)}`;

  const parsed = await ask<NormalizeVerdict>(prompt, opts);
  if (!parsed?.intent || typeof parsed.intent !== "string") return null;
  return parsed;
}
