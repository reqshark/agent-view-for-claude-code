// Triage domain types + the host<->webview protocol for the Triage view.
//
// PROTOCOL SYNC: everything below the "protocol" banner is mirrored in
// webview-ui/src/triage/protocol.ts. Edit BOTH or the panel breaks at runtime.

/** Where a question came from, which decides how conservatively it is handled. */
export type QuestionKind = "ask" | "permission" | "conflict";

export type QuestionCategory =
  | "tooling"
  | "convention"
  | "scope"
  | "permission"
  | "design"
  | "other";

/** How wide an answer is likely to apply — pre-selects the scope picker. */
export type ScopeHint = "file" | "module" | "repo" | "global";

export interface QuestionContext {
  /** Repo root (or cwd when the session isn't in a git repo). Partitions the log. */
  repo: string;
  branch: string;
  cwd: string;
  /** Recently touched files, used for pathGlob scope matching. */
  files: string[];
  /** Ticket id lifted out of the branch name, when there is one. */
  ticket?: string;
}

/** One session's request for a human answer, before any compression. */
export interface Question {
  id: string;
  sessionId: string;
  kind: QuestionKind;
  /** What the human reads. */
  text: string;
  /** What Normalize runs on, when it differs from `text` (see intake.ts). */
  intentText?: string;
  options?: string[];
  context: QuestionContext;
  createdAt: number;
}

/** Session-independent restatement of a Question — what dedup/lookup compare. */
export interface NormalizedQuestion {
  intent: string;
  category: QuestionCategory;
  entities: string[];
  scopeHint: ScopeHint;
}

export interface DecisionScope {
  /** Unset = every repo. */
  repo?: string;
  /** Glob, e.g. "feature/*". Unset = every branch. */
  branch?: string;
  /** Glob, e.g. "src/auth/**". Unset = every path. */
  pathGlob?: string;
  /** Set for "this session only" answers; never reused across sessions. */
  sessionId?: string;
}

/** A human answer, persisted so the next session doesn't have to ask. */
export interface Decision {
  id: string;
  clusterId: string;
  intent: string;
  /** Lexical fingerprint of the intent — this build's stand-in for an embedding. */
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
  /** Commit the repo was on when the decision was made — the churn baseline. */
  atCommit?: string;
  /** A session re-asked this after an auto-answer: the answer may not have landed. */
  repeatedAfterAutoAnswer?: boolean;
  /** Human confirmed the decision is still current, clearing staleness hints. */
  confirmedAt?: number;
  /** Human rewrote the answer — counts against the auto-answer error rate. */
  editedAt?: number;
}

export type ClusterState = "open" | "answered";

export interface ClusterMember {
  questionId: string;
  sessionId: string;
  label: string;
  /** Raw, unnormalized text — what the human reads before answering. */
  text: string;
  /** The narrower text Normalize ran on, kept so a manual split re-matches it. */
  intentText?: string;
  options?: string[];
  at: number;
  /** The session is suspended in a blocking hook, waiting on this answer. */
  held: boolean;
}

/** A group of Questions judged to be the same question. Surfaced once. */
export interface Cluster {
  id: string;
  kind: QuestionKind;
  norm: NormalizedQuestion;
  context: QuestionContext;
  members: ClusterMember[];
  createdAt: number;
  state: ClusterState;
  answer?: string;
  answeredAt?: number;
  /** Id of the Decision that auto-answered this cluster, when one did. */
  autoAnsweredFrom?: string;
  /** Auto-answer was simulated only (dry run) and the human still sees it. */
  dryRun?: boolean;
  /** A Decision matched but policy refused to apply it — shown, not applied. */
  suggestion?: { decisionId: string; answer: string; why: string };
}

// ---------------------------------------------------------------- protocol --

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
