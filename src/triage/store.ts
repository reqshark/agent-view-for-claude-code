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

/**
 * On-disk Decision Log, one per workspace, partitioned by `scope.repo`.
 *
 * The spec asks for SQLite + sqlite-vec. This uses plain JSON under
 * `.agentview/triage/` instead: a VS Code extension cannot ship a native
 * module without breaking on some of the platforms it has to run on, the v0
 * data volume is tiny (the spec itself says application-layer cosine is fine
 * at this size), and a readable JSON file is something the user can diff,
 * commit, and hand-edit. Swap the two methods below for a driver if the team
 * edition ever needs a real database.
 *
 *   decisions.json   the Decision Log (the durable part)
 *   metrics.json     success-metric counters + the circuit-breaker latch
 */
export class TriageStore {
  readonly dir: string;
  private readonly decisionsPath: string;
  private readonly metricsPath: string;
  private decisions: Decision[] | null = null;
  private metrics: TriageMetrics | null = null;

  constructor(workspaceRoot: string) {
    this.dir = path.join(workspaceRoot, ".agentview", "triage");
    this.decisionsPath = path.join(this.dir, "decisions.json");
    this.metricsPath = path.join(this.dir, "metrics.json");
  }

  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true });
  }

  listDecisions(): Decision[] {
    if (this.decisions) return this.decisions;
    try {
      const raw = JSON.parse(fs.readFileSync(this.decisionsPath, "utf8"));
      const list = Array.isArray(raw?.decisions) ? raw.decisions : [];
      this.decisions = list.filter((d: any) => d && typeof d.id === "string" && typeof d.answer === "string");
    } catch {
      this.decisions = [];
    }
    return this.decisions!;
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

  private saveDecisions(): void {
    this.ensure();
    atomicWrite(
      this.decisionsPath,
      JSON.stringify({ version: 1, updatedAt: Date.now(), decisions: this.listDecisions() }, null, 2),
    );
  }

  readMetrics(): TriageMetrics {
    if (this.metrics) return this.metrics;
    try {
      const raw = JSON.parse(fs.readFileSync(this.metricsPath, "utf8"));
      this.metrics = { ...emptyMetrics(), ...(raw?.metrics || {}) };
      if (!Array.isArray(this.metrics!.holdMs)) this.metrics!.holdMs = [];
    } catch {
      this.metrics = emptyMetrics();
    }
    return this.metrics!;
  }

  updateMetrics(patch: (m: TriageMetrics) => void): TriageMetrics {
    const m = this.readMetrics();
    patch(m);
    if (m.holdMs.length > MAX_HOLD_SAMPLES) m.holdMs = m.holdMs.slice(-MAX_HOLD_SAMPLES);
    this.ensure();
    try {
      atomicWrite(this.metricsPath, JSON.stringify({ version: 1, metrics: m }, null, 2));
    } catch {
      /* metrics are advisory — never fail a user action over them */
    }
    return m;
  }
}
