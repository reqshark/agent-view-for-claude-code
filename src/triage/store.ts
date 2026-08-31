import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import { Decision } from "./types";

function atomicWrite(file: string, data: string): void {
  const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

/** Rolling metric counters (spec S10) — cheap enough to keep exact. */
export interface TriageMetrics {
  /** Every Question intaken, before dedup. */
  rawQuestions: number;
  /** Clusters the human actually answered (the numerator of compression). */
  clustersAnswered: number;
  /** Questions resolved from the Decision Log without the human. */
  autoAnswers: number;
  /** Questions the human answered at the session instead of in the inbox. */
  resolvedAtSession: number;
  /** Hold durations, capped — the median is reported, informational only. */
  holdMs: number[];
  /** The circuit-breaker warning has been shown; don't nag on every scan.
   *  The breaker itself is derived from the live decisions, so it recovers on
   *  its own once the bad decisions are revoked. */
  circuitNotified: boolean;
}

function emptyMetrics(): TriageMetrics {
  return {
    rawQuestions: 0,
    clustersAnswered: 0,
    autoAnswers: 0,
    resolvedAtSession: 0,
    holdMs: [],
    circuitNotified: false,
  };
}

const MAX_HOLD_SAMPLES = 200;

/** Where each half of Triage's state lives, resolved fresh on every access so
 *  changing `mas.triage.storage` takes effect without a window reload. */
export interface TriagePaths {
  /** The Decision Log. Repo-local only when the user opts in. */
  decisionsPath: string;
  /** Per-machine counters. Never repo-local — nothing here is worth committing. */
  metricsPath: string;
  /** A pre-0.9.2 repo-local log to adopt if `decisionsPath` has none yet. */
  adoptFrom?: string;
}

/**
 * Triage's persistent state.
 *
 * Nothing is written until there is something to record: the first question a
 * session asks, or the first decision the human makes. With `mas.triage.enabled`
 * off, no file is ever created.
 *
 * The spec asks for SQLite + sqlite-vec. This uses plain JSON: a VS Code
 * extension cannot ship a native module without breaking on some of the
 * platforms it has to run on, the v0 data volume is tiny (the spec itself says
 * application-layer cosine is fine at this size), and a readable JSON file is
 * something the user can diff, commit, and hand-edit.
 *
 * The two halves are stored separately on purpose. The Decision Log is content
 * a team might want to commit and share; the metric counters are per-machine
 * scratch that would only ever be merge-conflict noise. Splitting them means
 * repo storage puts exactly one file in the user's project, and the default
 * puts none.
 */
export class TriageStore {
  private decisions: Decision[] | null = null;
  private decisionsFrom = "";
  private metrics: TriageMetrics | null = null;
  private metricsFrom = "";

  constructor(private readonly getPaths: () => TriagePaths) {}

  /** Create a file's directory only at the moment we actually write it. */
  private ensureDirFor(file: string): void {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  listDecisions(): Decision[] {
    const { decisionsPath, adoptFrom } = this.getPaths();
    if (this.decisions && this.decisionsFrom === decisionsPath) return this.decisions;
    this.decisionsFrom = decisionsPath;
    this.decisions = readDecisions(decisionsPath);
    // Storage moved (or 0.9.2 relocated the default): pick up the log that was
    // left behind rather than silently starting empty. The original is left
    // alone — it is in the user's repo and theirs to delete.
    if (this.decisions.length === 0 && adoptFrom && adoptFrom !== decisionsPath) {
      const adopted = readDecisions(adoptFrom);
      if (adopted.length > 0) {
        this.decisions = adopted;
        this.saveDecisions();
      }
    }
    return this.decisions;
  }

  getDecision(id: string): Decision | undefined {
    return this.listDecisions().find((d) => d.id === id);
  }

  addDecision(d: Decision): void {
    this.listDecisions().unshift(d);
    this.saveDecisions();
  }

  /** Mutate a decision in place and persist. Returns false when it's gone. */
  updateDecision(id: string, patch: (d: Decision) => void): boolean {
    const d = this.getDecision(id);
    if (!d) return false;
    patch(d);
    this.saveDecisions();
    return true;
  }

  /** Absolute path the Decision Log is currently written to (shown in the UI). */
  decisionsLocation(): string {
    return this.getPaths().decisionsPath;
  }

  private saveDecisions(): void {
    const file = this.getPaths().decisionsPath;
    this.ensureDirFor(file);
    atomicWrite(
      file,
      JSON.stringify({ version: 1, updatedAt: Date.now(), decisions: this.decisions || [] }, null, 2),
    );
  }

  readMetrics(): TriageMetrics {
    const { metricsPath } = this.getPaths();
    if (this.metrics && this.metricsFrom === metricsPath) return this.metrics;
    this.metricsFrom = metricsPath;
    let next: TriageMetrics;
    try {
      const raw = JSON.parse(fs.readFileSync(metricsPath, "utf8"));
      next = { ...emptyMetrics(), ...(raw?.metrics || {}) };
      if (!Array.isArray(next.holdMs)) next.holdMs = [];
    } catch {
      next = emptyMetrics();
    }
    this.metrics = next;
    return next;
  }

  updateMetrics(patch: (m: TriageMetrics) => void): TriageMetrics {
    const m = this.readMetrics();
    patch(m);
    if (m.holdMs.length > MAX_HOLD_SAMPLES) m.holdMs = m.holdMs.slice(-MAX_HOLD_SAMPLES);
    const file = this.getPaths().metricsPath;
    try {
      this.ensureDirFor(file);
      atomicWrite(file, JSON.stringify({ version: 1, metrics: m }, null, 2));
    } catch {
      /* metrics are advisory — never fail a user action over them */
    }
    return m;
  }
}

function readDecisions(file: string): Decision[] {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    const list = Array.isArray(raw?.decisions) ? raw.decisions : [];
    return list.filter((d: any) => d && typeof d.id === "string" && typeof d.answer === "string");
  } catch {
    return [];
  }
}
