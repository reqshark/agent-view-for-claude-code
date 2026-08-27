// MIRROR of the protocol half of src/triage/types.ts.
//
// PROTOCOL SYNC (see AGENTS.md): the webview lives under its own tsconfig root,
// so there is no shared import. Any change to a message or row shape must be
// made in BOTH files or the Triage panel silently breaks at runtime.

export type QuestionKind = "ask" | "permission" | "conflict";

export type QuestionCategory =
  | "tooling"
  | "convention"
  | "scope"
  | "permission"
  | "design"
  | "other";

export type ScopeHint = "file" | "module" | "repo" | "global";

export interface DecisionScope {
  repo?: string;
  branch?: string;
  pathGlob?: string;
  sessionId?: string;
}

export interface Decision {
  id: string;
  clusterId: string;
  intent: string;
  keywords: string[];
  kind: QuestionKind;
  category: QuestionCategory;
  answer: string;
  scope: DecisionScope;
  expiresAt?: number;
  revokedAt?: number;
  revokeReason?: string;
  createdAt: number;
  hitCount: number;
  lastHitAt?: number;
  atCommit?: string;
  repeatedAfterAutoAnswer?: boolean;
  confirmedAt?: number;
  editedAt?: number;
}

export type AnswerScope = "session" | "branch" | "repo" | "global";
export type AnswerExpiry = "once" | "today" | "week" | "forever";

/** One open Cluster as rendered in the Inbox. */
export interface TriageRow {
  id: string;
  kind: QuestionKind;
  category: QuestionCategory;
  intent: string;
  scopeHint: ScopeHint;
  repo: string;
  repoName: string;
  branch?: string;
  createdAt: number;
  options: string[];
  waiting: {
    questionId: string;
    sessionId: string;
    label: string;
    text: string;
    held: boolean;
    at: number;
  }[];
  /** The same intent is open in this many OTHER repos — shown, never merged. */
  alsoInRepos: number;
  /** A Decision matched but policy refused to use it (kind or circuit breaker). */
  suggestion?: { decisionId: string; answer: string; why: string };
}

/** An auto-answered Cluster, kept for review. */
export interface AutoRow {
  clusterId: string;
  decisionId: string;
  intent: string;
  answer: string;
  sessions: string[];
  at: number;
  dryRun: boolean;
  /** Bumped to normal priority: this Decision's first use, so glance at it. */
  bumped: boolean;
  reviewed: boolean;
}

export interface DecisionRow extends Decision {
  /** Non-empty when a staleness signal fired; hint only, never auto-expiry. */
  staleReason?: string;
  expired: boolean;
}

/** Success metrics (spec S10) — all computed, none estimated. */
export interface TriageStats {
  rawQuestions: number;
  clustersAnswered: number;
  /** clustersAnswered / rawQuestions — lower is better, target < 0.4. */
  compression: number;
  autoAnswers: number;
  /** autoAnswers / rawQuestions — target > 0.3. */
  autoHitRate: number;
  /** Auto-answers later revoked or edited / autoAnswers — ceiling 0.05. */
  autoErrorRate: number;
  /** Informational: how fast the human replies. */
  medianHoldMs: number;
  /** The error ceiling was breached and auto-answer forced itself to dry run. */
  circuitOpen: boolean;
}

export interface TriageState {
  enabled: boolean;
  /** Claude is adjudicating matches (on, consented, and reachable). */
  ai: boolean;
  autoAnswerEnabled: boolean;
  dryRun: boolean;
  holdEnabled: boolean;
  /** Hold needs the MAS hooks installed; without them nothing is suspended. */
  hooksInstalled: boolean;
  defaultScope: AnswerScope;
  defaultExpiry: AnswerExpiry;
  inbox: TriageRow[];
  auto: AutoRow[];
  decisions: DecisionRow[];
  stats: TriageStats;
}

export type ExtToTriage = { type: "state"; state: TriageState };

export type TriageToExt =
  | { type: "ready" }
  | { type: "refresh" }
  | {
      type: "answer";
      clusterId: string;
      answer: string;
      scope: AnswerScope;
      expiry: AnswerExpiry;
    }
  | { type: "dismiss"; clusterId: string }
  | { type: "split"; clusterId: string; questionId: string }
  | { type: "openSession"; sessionId: string }
  | { type: "revokeDecision"; decisionId: string; reason?: string }
  | { type: "confirmDecision"; decisionId: string }
  | { type: "editDecision"; decisionId: string; answer: string }
  | { type: "reviewAuto"; clusterId: string }
  | { type: "undoAuto"; clusterId: string }
  | { type: "setDryRun"; on: boolean };
