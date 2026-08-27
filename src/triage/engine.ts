import * as vscode from "vscode";
import * as path from "path";
import { AgentStore } from "../store";
import { AgentSession } from "../types";
import { Conflict } from "../webview/protocol";
import { stripMarkdown } from "../util/markdown";
import { judgeDecisionApplies, judgeNormalize, judgeSameQuestion, JudgeOptions } from "./judge";
import { HoldRegistry } from "./hold";
import { TriageStore } from "./store";
import {
  contextFor,
  conflictQuestions,
  pendingQuestion,
  questionFromAskHook,
  questionFromNotification,
  RawQuestion,
  toQuestion,
} from "./intake";
import { Fingerprint, fingerprint, globMatch, normalizeQuestion, similarity } from "./text";
import {
  AnswerExpiry,
  AnswerScope,
  AutoRow,
  Cluster,
  ClusterMember,
  Decision,
  DecisionRow,
  NormalizedQuestion,
  Question,
  QuestionCategory,
  TriageRow,
  TriageState,
  TriageStats,
} from "./types";

export interface TriageConfig {
  enabled: boolean;
  dedupThreshold: number;
  lookupThreshold: number;
  autoAnswerEnabled: boolean;
  dryRun: boolean;
  /** Let Claude adjudicate "same question?" and "does this decision answer it?".
   *  Falls back to the lexical measure when off, declined, or unreachable. */
  ai: boolean;
  aiModel: string;
  claudePath: string;
  conflictDetect: boolean;
  defaultScope: AnswerScope;
  defaultExpiry: AnswerExpiry;
  holdEnabled: boolean;
  holdTimeoutSeconds: number;
}

export interface TriageDeps {
  /** Type the answer into the agent's own terminal. False when there isn't one. */
  dispatchToTerminal(sessionId: string, answer: string): boolean;
  /** Last resort for sessions with no terminal we own — hand it to the human.
   *  Batched: one answer can strand several sessions, and that is one message. */
  handoff(targets: { sessionId: string; label: string }[], answer: string): void;
  /** Repo root for a session (the Decision Log's partition key). */
  repoRoot(session: AgentSession): string;
  /** HEAD of a repo, for the churn staleness baseline. "" when unavailable. */
  headCommit(repo: string): Promise<string>;
  /** Lines changed under `pathGlob` since `sinceCommit`; -1 when unknown. */
  churn(repo: string, sinceCommit: string, pathGlob?: string): Promise<number>;
  hooksInstalled(): boolean;
  notify(message: string): void;
  /** One-time consent gate for the optional AI Normalize pass. */
  llmConsent(): Promise<boolean>;
}

/** Auto-answer error ceiling (spec S10). Above this, auto-answer self-demotes. */
const ERROR_CEILING = 0.05;
/** Don't judge the error rate until there's enough evidence to judge it on. */
const ERROR_MIN_SAMPLE = 10;
/** A reworded re-ask this soon after an auto-answer means the answer missed. */
const REPEAT_WINDOW_MS = 10 * 60 * 1000;
/** Similarity that counts as "reworded but the same question". */
const REPEAT_SIMILARITY = 0.7;
/** Changed lines under a decision's pathGlob before it reads as stale. */
const CHURN_STALE_LINES = 200;
const MAX_AUTO_ROWS = 50;
/**
 * Below this lexical score a decision-log entry is not worth a model call. The
 * log can grow large, so it needs *some* floor; it is deliberately low, because
 * the lexical score is only a ranking hint here and must never be the reason
 * Claude was not asked. There is no floor at all on open clusters — there are
 * only ever a handful, so the candidate cap alone bounds the cost.
 */
const DECISION_FLOOR = 0.15;
/** At most this many candidates get adjudicated per question, in rank order. */
const MAX_JUDGED_CANDIDATES = 3;
const STALENESS_REFRESH_MS = 120_000;

interface StoredCluster extends Cluster {
  /** Fingerprint of the normalized intent — what decision-log matching uses. */
  fp: Fingerprint;
  /** Fingerprint of the raw question. Normalize (especially the AI pass) can
   *  word two identical questions differently, so ranking candidates on the
   *  rewritten intent would hide real matches from the adjudicator. The raw
   *  text is the stable thing to rank on. */
  rawFp: Fingerprint;
}

/**
 * The Triage Engine (spec S5.2): normalize -> dedup -> lookup -> route.
 *
 * It owns the open Clusters, decides what the human sees, and is the only
 * thing that ever answers on the human's behalf. Every step is conservative by
 * construction: conflicts and permissions are never auto-answered from a
 * generic Decision, an auto-answer leaves an auditable record, and the error
 * rate demotes auto-answer to dry run on its own.
 */
export class TriageEngine {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  readonly holds = new HoldRegistry();

  private readonly clusters = new Map<string, StoredCluster>();
  private auto: AutoRow[] = [];
  /** decisionId -> staleness hint, refreshed off the git churn probe. */
  private readonly staleHints = new Map<string, string>();
  /** sessionId -> the decision that just auto-answered it (repeat detector). */
  private readonly recentAuto = new Map<string, { decisionId: string; at: number }>();
  /** Question ids mid-ingest. `normalize` can await (the AI pass), and a hook
   *  and a scan can reach the same question at once — without this they would
   *  each create a cluster for it. */
  private readonly ingesting = new Set<string>();
  /** Last pendingQuestion() result per session, keyed to the transcript state it
   *  was read from. Re-parsing a large JSONL on every store tick is the one
   *  thing here that could actually cost the user something. */
  private readonly scanned = new Map<string, { at: number; raw: RawQuestion | null }>();
  private readonly disposables: vscode.Disposable[] = [];
  private scanning = false;
  private scanTimer?: NodeJS.Timeout;
  private staleTimer?: NodeJS.Timeout;
  private consentDeclined = false;
  private seq = 0;

  constructor(
    private readonly store: AgentStore,
    private readonly triageStore: TriageStore,
    private readonly getConfig: () => TriageConfig,
    private readonly deps: TriageDeps,
  ) {}

  start(): void {
    this.disposables.push(this.store.onDidChange(() => this.scheduleScan()));
    this.staleTimer = setInterval(() => void this.refreshStaleness(), STALENESS_REFRESH_MS);
    this.scheduleScan();
  }

  dispose(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    if (this.staleTimer) clearInterval(this.staleTimer);
    this.holds.dispose();
    while (this.disposables.length) this.disposables.pop()?.dispose();
    this._onDidChange.dispose();
  }

  // ------------------------------------------------------------- intake --

  /**
   * A session parked in the blocking AskUserQuestion hook. Resolves with the
   * text to feed back to the agent, or null to let Claude Code prompt as usual.
   */
  async intakeHeld(event: any): Promise<string | null> {
    const cfg = this.getConfig();
    if (!cfg.enabled || !cfg.holdEnabled) return null;
    const raw = questionFromAskHook(event);
    const sessionId = event?.session_id || event?.sessionId;
    if (!raw || !sessionId) return null;
    let session = this.store.getById(sessionId);
    if (!session) {
      // A hook can beat discovery for a session that just started; one forced
      // re-read is cheaper than dropping the ask on the floor.
      this.store.refresh();
      session = this.store.getById(sessionId);
      if (!session) return null;
    }

    const q = toQuestion(raw, session, contextFor(session, this.deps.repoRoot(session)));
    const answered = await this.ingest(q, session, true);
    if (answered !== null) return answered;
    return this.holds.hold(q.id, sessionId, Math.max(5, cfg.holdTimeoutSeconds) * 1000);
  }

  /** A permission Notification from the hook server (never held, never auto). */
  onHookEvent(event: any): void {
    if (!this.getConfig().enabled) return;
    const raw = questionFromNotification(event);
    if (!raw) return;
    const sessionId = event?.session_id || event?.sessionId;
    const session = sessionId && this.store.getById(sessionId);
    if (!session) return;
    void this.ingest(
      toQuestion(raw, session, contextFor(session, this.deps.repoRoot(session))),
      session,
      false,
    );
  }

  private judgeOptions(cfg: TriageConfig): JudgeOptions {
    return { claudePath: cfg.claudePath, model: cfg.aiModel, timeoutMs: 45_000 };
  }

  /** True when Claude may be called: enabled, and the user has consented once.
   *  The consent answer is remembered by the host, so this is a single modal
   *  ever, not a prompt per question. */
  private async aiAvailable(cfg: TriageConfig): Promise<boolean> {
    if (!cfg.ai || this.consentDeclined) return false;
    if (await this.deps.llmConsent()) return true;
    this.consentDeclined = true;
    return false;
  }

  private scheduleScan(): void {
    if (this.scanTimer) clearTimeout(this.scanTimer);
    this.scanTimer = setTimeout(() => void this.scan(), 600);
  }

  /** Poll the fleet for blocked sessions — the zero-config intake path. */
  private async scan(): Promise<void> {
    if (this.scanning) return;
    this.scanning = true;
    try {
      await this.runScan();
    } finally {
      this.scanning = false;
    }
  }

  private async runScan(): Promise<void> {
    const cfg = this.getConfig();
    if (!cfg.enabled) {
      if (this.clusters.size) {
        this.clusters.clear();
        this._onDidChange.fire();
      }
      return;
    }

    const sessions = this.store.list();
    const byId = new Map(sessions.map((s) => [s.sessionId, s]));

    for (const session of sessions) {
      if (session.kind !== "session") continue;
      if (session.status !== "waiting") continue;
      const raw = this.pendingFor(session);
      if (!raw) continue;
      await this.ingest(
        toQuestion(raw, session, contextFor(session, this.deps.repoRoot(session))),
        session,
        this.holds.isHeld(raw.key),
      );
    }

    const liveConflicts = cfg.conflictDetect ? await this.ingestConflicts(byId) : new Set<string>();
    this.prune(byId, liveConflicts);
    this._onDidChange.fire();
  }

  /** Returns the ids of the conflicts that are still live, so prune() can
   *  retire the rows for collisions that have since been resolved. */
  /** pendingQuestion(), memoized against the session's own activity clock. */
  private pendingFor(session: AgentSession): RawQuestion | null {
    const cached = this.scanned.get(session.sessionId);
    if (cached && cached.at === session.lastActivity) return cached.raw;
    const raw = pendingQuestion(session);
    this.scanned.set(session.sessionId, { at: session.lastActivity, raw });
    return raw;
  }

  private async ingestConflicts(byId: Map<string, AgentSession>): Promise<Set<string>> {
    const live = this.store
      .list()
      .filter((s) => s.managed || s.status === "running" || s.status === "waiting");
    const ids = new Set<string>();
    for (const { raw, session } of conflictQuestions(
      computeFileConflicts(live),
      byId,
      (s) => this.deps.repoRoot(s),
    )) {
      ids.add(raw.key);
      await this.ingest(
        toQuestion(raw, session, contextFor(session, this.deps.repoRoot(session))),
        session,
        false,
      );
    }
    return ids;
  }

  /**
   * The pipeline proper. Returns the answer when the Question was resolved
   * without the human (auto-answer), otherwise null.
   */
  private async ingest(q: Question, session: AgentSession, held: boolean): Promise<string | null> {
    // Already tracked: refresh the hold flag and stop — re-intaking the same
    // ask on every heartbeat would inflate every metric in the panel.
    const existing = this.findMember(q.id);
    if (existing) {
      existing.member.held = existing.member.held || held;
      return null;
    }
    if (this.ingesting.has(q.id)) return null;
    this.ingesting.add(q.id);
    try {
      return await this.runIngest(q, session, held);
    } finally {
      this.ingesting.delete(q.id);
    }
  }

  private async runIngest(q: Question, session: AgentSession, held: boolean): Promise<string | null> {
    this.triageStore.updateMetrics((m) => void m.rawQuestions++);
    const norm = await this.normalize(q);
    const fp = fingerprint(norm);
    const member: ClusterMember = {
      questionId: q.id,
      sessionId: q.sessionId,
      label: session.label,
      text: q.text,
      intentText: q.intentText,
      options: q.options,
      at: q.createdAt,
      held,
    };

    // Conflicts bypass dedup and lookup entirely (spec S5.1B / S6.3).
    if (q.kind === "conflict") {
      if (!this.clusters.has(q.id)) {
        this.clusters.set(q.id, this.newCluster(q.id, q, norm, fp, [member]));
        this._onDidChange.fire();
      }
      return null;
    }

    const cfg = this.getConfig();

    // Step 2 — dedup, within one repo only. Cross-repo matches are surfaced in
    // the row ("also asked in N repos") but never merged: the answers differ.
    const twin = await this.findTwin(q, fp, cfg);
    if (twin) {
      twin.members.push(member);
      this.flagRepeat(q, fp, cfg);
      this._onDidChange.fire();
      return null;
    }

    // Step 3 — lookup. Only a brand-new cluster may be auto-answered; joining
    // one the human is already looking at and answering it behind their back
    // would be worse than asking twice.
    const cluster = this.newCluster(`c${++this.seq}-${q.id}`, q, norm, fp, [member]);
    this.clusters.set(cluster.id, cluster);
    this.flagRepeat(q, fp, cfg);

    const match = await this.lookupDecision(q, fp, cfg);
    if (match) {
      const refusal = this.refuseAutoAnswer(q, match.decision, cfg);
      if (!refusal) {
        this.applyAutoAnswer(cluster, match.decision, cfg);
        this._onDidChange.fire();
        return cluster.dryRun ? null : match.decision.answer;
      }
      cluster.suggestion = { decisionId: match.decision.id, answer: match.decision.answer, why: refusal };
    }

    this._onDidChange.fire();
    return null;
  }

  private newCluster(
    id: string,
    q: Question,
    norm: NormalizedQuestion,
    fp: Fingerprint,
    members: ClusterMember[],
  ): StoredCluster {
    return {
      id,
      kind: q.kind,
      norm,
      context: q.context,
      members,
      createdAt: q.createdAt,
      state: "open",
      fp,
      rawFp: fingerprint({ intent: q.intentText || q.text }),
    };
  }

  private findMember(questionId: string): { cluster: StoredCluster; member: ClusterMember } | undefined {
    for (const cluster of this.clusters.values()) {
      const member = cluster.members.find((m) => m.questionId === questionId);
      if (member) return { cluster, member };
    }
    return undefined;
  }

  /** Open clusters in the same repo and of the same kind, best lexical match
   *  first. The lexical measure never decides on its own when AI is on — it
   *  only decides what is worth asking Claude about. */
  private candidates(q: Question, fp: Fingerprint): { cluster: StoredCluster; score: number }[] {
    const rawFp = fingerprint({ intent: q.intentText || q.text });
    const out: { cluster: StoredCluster; score: number }[] = [];
    for (const c of this.clusters.values()) {
      if (c.state !== "open" || c.kind !== q.kind) continue;
      if (c.context.repo !== q.context.repo) continue;
      // Best of the two views: the normalized intents, or the raw questions.
      out.push({
        cluster: c,
        score: Math.max(similarity(fp, c.fp), similarity(rawFp, c.rawFp)),
      });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /**
   * The open cluster this question belongs to, if any.
   *
   * With AI on: the lexical score picks the shortlist and settles the obvious
   * cases (near-identical text merges, unrelated text is dropped without a
   * call), and Claude adjudicates the band in between — which is exactly where
   * token overlap is wrong ("install deps" vs "install dependencies" merges;
   * "tests for auth" vs "tests for billing" does not).
   *
   * With AI off, declined, or unreachable, the lexical threshold decides alone.
   */
  private async findTwin(
    q: Question,
    fp: Fingerprint,
    cfg: TriageConfig,
  ): Promise<StoredCluster | undefined> {
    const ranked = this.candidates(q, fp);
    if (ranked.length === 0) return undefined;
    const ai = await this.aiAvailable(cfg);
    if (!ai) {
      const top = ranked[0];
      return top.score >= cfg.dedupThreshold ? top.cluster : undefined;
    }
    for (const { cluster, score } of ranked.slice(0, MAX_JUDGED_CANDIDATES)) {
      if (score >= cfg.dedupThreshold) return cluster; // near-identical; no call needed
      const verdict = await judgeSameQuestion(
        q.intentText || q.text,
        cluster.members[0]?.text || cluster.norm.intent,
        this.judgeOptions(cfg),
      );
      if (verdict === null) {
        // Claude was unreachable mid-flight: fall back to the lexical rule
        // rather than silently splitting questions that should have merged.
        return ranked[0].score >= cfg.dedupThreshold ? ranked[0].cluster : undefined;
      }
      if (verdict.same) return cluster;
    }
    return undefined;
  }

  // ------------------------------------------------------- decision log --

  /**
   * Step 3 — the Decision Log lookup, and the gate in front of every
   * auto-answer.
   *
   * Scope, expiry and revocation are hard filters — a decision that does not
   * cover this question's repo/branch/path never gets considered, model or no
   * model. Among what survives, the lexical score shortlists and Claude makes
   * the call: with AI on, EVERY auto-answer is model-confirmed, including the
   * ones the lexical measure was already confident about. Auto-answer is the
   * one place Triage acts without the human, so it is worth a call.
   */
  private async lookupDecision(
    q: Question,
    fp: Fingerprint,
    cfg: TriageConfig,
  ): Promise<{ decision: Decision; score: number } | undefined> {
    const now = Date.now();
    const eligible: { decision: Decision; score: number }[] = [];
    for (const d of this.triageStore.listDecisions()) {
      if (d.revokedAt) continue;
      if (d.expiresAt && d.expiresAt <= now) continue;
      if (!scopeCovers(d.scope, q)) continue;
      eligible.push({ decision: d, score: similarity(fp, fingerprint(d)) });
    }
    if (eligible.length === 0) return undefined;
    eligible.sort((a, b) => b.score - a.score);

    if (!(await this.aiAvailable(cfg))) {
      const top = eligible[0];
      return top.score >= cfg.lookupThreshold ? top : undefined;
    }

    for (const candidate of eligible.slice(0, MAX_JUDGED_CANDIDATES)) {
      if (candidate.score < DECISION_FLOOR) break; // ranked desc; nothing below is closer
      const verdict = await judgeDecisionApplies(
        q.intentText || q.text,
        { intent: candidate.decision.intent, answer: candidate.decision.answer },
        this.judgeOptions(cfg),
      );
      // Unreachable mid-flight: fall back to the lexical threshold, which is
      // the stricter of the two and was the pre-AI behaviour.
      if (verdict === null) {
        const top = eligible[0];
        return top.score >= cfg.lookupThreshold ? top : undefined;
      }
      if (verdict.answers) return candidate;
    }
    return undefined;
  }

  /** Why this Decision must not be used automatically — empty when it may be. */
  private refuseAutoAnswer(q: Question, d: Decision, cfg: TriageConfig): string {
    if (!cfg.autoAnswerEnabled) return "Auto-answer is off — answer once to reuse this.";
    if (q.kind === "conflict") return "Conflicts are never auto-answered.";
    if (q.kind === "permission" && d.kind !== "permission") {
      return "Permission asks only reuse decisions you made on a permission ask.";
    }
    if (this.stats().circuitOpen) {
      return "Auto-answer error rate is above the ceiling — running in dry run.";
    }
    return "";
  }

  private applyAutoAnswer(cluster: StoredCluster, d: Decision, cfg: TriageConfig): void {
    const dryRun = cfg.dryRun;
    cluster.autoAnsweredFrom = d.id;
    cluster.dryRun = dryRun;

    if (dryRun) {
      cluster.suggestion = {
        decisionId: d.id,
        answer: d.answer,
        why: "Dry run — Triage would have answered this from the Decision Log.",
      };
    } else {
      cluster.answer = d.answer;
      cluster.answeredAt = Date.now();
      cluster.state = "answered";
      this.dispatchAll(cluster.members, d.answer);
      for (const m of cluster.members) {
        this.recentAuto.set(m.sessionId, { decisionId: d.id, at: Date.now() });
      }
      this.triageStore.updateDecision(d.id, (dec) => {
        dec.hitCount++;
        dec.lastHitAt = Date.now();
      });
      this.triageStore.updateMetrics((m) => void m.autoAnswers++);
      this.clusters.delete(cluster.id);
    }

    this.pushAuto({
      clusterId: cluster.id,
      decisionId: d.id,
      intent: cluster.norm.intent,
      answer: d.answer,
      sessions: cluster.members.map((m) => m.label),
      at: Date.now(),
      dryRun,
      // First uses of a Decision are worth a glance; after three clean hits it
      // drops back to low priority (spec S6.3).
      bumped: d.hitCount < 3,
      reviewed: false,
    });
  }

  private pushAuto(row: AutoRow): void {
    this.auto.unshift(row);
    if (this.auto.length > MAX_AUTO_ROWS) this.auto.length = MAX_AUTO_ROWS;
  }

  /** Staleness signal: the same session re-asks, reworded, right after an
   *  auto-answer — a sign the answer didn't actually resolve it (spec S6.2). */
  private flagRepeat(q: Question, fp: Fingerprint, cfg: TriageConfig): void {
    const recent = this.recentAuto.get(q.sessionId);
    if (!recent || Date.now() - recent.at > REPEAT_WINDOW_MS) return;
    const d = this.triageStore.getDecision(recent.decisionId);
    if (!d) return;
    const score = similarity(fp, fingerprint(d));
    if (score < REPEAT_SIMILARITY || score >= cfg.dedupThreshold) return;
    this.triageStore.updateDecision(d.id, (dec) => void (dec.repeatedAfterAutoAnswer = true));
  }

  // ------------------------------------------------------------ actions --

  /** The human answers a Cluster: dispatch to everyone waiting, then record it. */
  answer(clusterId: string, text: string, scope: AnswerScope, expiry: AnswerExpiry): void {
    const cluster = this.clusters.get(clusterId);
    const answer = text.trim();
    if (!cluster || cluster.state !== "open" || !answer) return;

    const now = Date.now();
    cluster.answer = answer;
    cluster.answeredAt = now;
    cluster.state = "answered";

    this.dispatchAll(cluster.members, answer);

    this.triageStore.updateMetrics((m) => {
      m.clustersAnswered++;
      for (const member of cluster.members) m.holdMs.push(Math.max(0, now - member.at));
    });

    // "once" is deliberately not written to the log — the human said this time
    // only, and a Decision is by definition reusable.
    if (expiry !== "once" && cluster.kind !== "conflict") {
      this.recordDecision(cluster, answer, scope, expiry);
    }

    this.clusters.delete(clusterId);
    this._onDidChange.fire();
  }

  /** Persist the answer as a reusable Decision. The insert is synchronous so
   *  the Decisions tab shows it the instant the human answers; the churn
   *  baseline is a git probe and lands a moment later. */
  private recordDecision(
    cluster: StoredCluster,
    answer: string,
    scope: AnswerScope,
    expiry: AnswerExpiry,
  ): void {
    const repo = cluster.context.repo;
    const decision: Decision = {
      id: `d${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`,
      clusterId: cluster.id,
      intent: cluster.norm.intent,
      keywords: cluster.norm.entities,
      kind: cluster.kind,
      category: cluster.norm.category,
      answer,
      scope: toDecisionScope(scope, cluster),
      expiresAt: expiryToTimestamp(expiry),
      createdAt: Date.now(),
      hitCount: 0,
    };
    this.triageStore.addDecision(decision);
    void this.deps
      .headCommit(repo)
      .then((sha) => {
        if (sha) this.triageStore.updateDecision(decision.id, (d) => void (d.atCommit = sha));
      })
      // No baseline just means this decision has no churn staleness signal.
      .catch(() => undefined);
  }

  /** Send an answer to every session waiting on it, by the best channel each
   *  has: release its hold, else type into its terminal, else hand the leftovers
   *  to the human in a single message. */
  private dispatchAll(members: ClusterMember[], answer: string): void {
    // A terminal submits on the first newline, so a multi-line answer has to
    // arrive as one line or the agent only ever sees the first sentence.
    const oneLine = answer.replace(/\s*\n+\s*/g, " ").trim();
    const stranded: { sessionId: string; label: string }[] = [];
    for (const m of members) {
      if (this.holds.release(m.questionId, answer)) continue;
      if (this.deps.dispatchToTerminal(m.sessionId, oneLine)) continue;
      stranded.push({ sessionId: m.sessionId, label: m.label });
    }
    if (stranded.length) this.deps.handoff(stranded, answer);
  }

  dismiss(clusterId: string): void {
    const cluster = this.clusters.get(clusterId);
    if (!cluster) return;
    // Let anything parked on this fall through to Claude Code's own prompt
    // rather than leaving the session suspended on a question nobody will
    // answer here.
    for (const m of cluster.members) this.holds.release(m.questionId, null);
    this.clusters.delete(clusterId);
    this._onDidChange.fire();
  }

  /** Pull one Question out of a Cluster the human judges to be a mis-merge. */
  split(clusterId: string, questionId: string): void {
    const cluster = this.clusters.get(clusterId);
    if (!cluster || cluster.members.length < 2) return;
    const idx = cluster.members.findIndex((m) => m.questionId === questionId);
    if (idx < 0) return;
    const [member] = cluster.members.splice(idx, 1);
    const norm = normalizeQuestion(member.intentText || member.text, {
      permission: cluster.kind === "permission",
      options: member.options,
    });
    const id = `c${++this.seq}-${member.questionId}`;
    this.clusters.set(id, {
      id,
      kind: cluster.kind,
      norm,
      context: cluster.context,
      members: [member],
      createdAt: member.at,
      state: "open",
      fp: fingerprint(norm),
      rawFp: fingerprint({ intent: member.intentText || member.text }),
    });
    this._onDidChange.fire();
  }

  revokeDecision(decisionId: string, reason?: string): void {
    this.triageStore.updateDecision(decisionId, (d) => {
      d.revokedAt = Date.now();
      d.revokeReason = reason;
    });
    this.staleHints.delete(decisionId);
    this.checkCircuit();
    this._onDidChange.fire();
  }

  confirmDecision(decisionId: string): void {
    this.triageStore.updateDecision(decisionId, (d) => {
      d.confirmedAt = Date.now();
      d.repeatedAfterAutoAnswer = false;
      d.atCommit = undefined; // re-baseline: churn since now, not since creation
    });
    this.staleHints.delete(decisionId);
    this._onDidChange.fire();
  }

  editDecision(decisionId: string, answer: string): void {
    const next = answer.trim();
    if (!next) return;
    this.triageStore.updateDecision(decisionId, (d) => {
      if (d.answer !== next) d.editedAt = Date.now();
      d.answer = next;
      d.repeatedAfterAutoAnswer = false;
    });
    this.checkCircuit();
    this._onDidChange.fire();
  }

  markAutoReviewed(clusterId: string): void {
    const row = this.auto.find((a) => a.clusterId === clusterId);
    if (!row) return;
    row.reviewed = true;
    this._onDidChange.fire();
  }

  /** "That auto-answer was wrong": revoke its Decision so it can't happen again. */
  undoAuto(clusterId: string): void {
    const row = this.auto.find((a) => a.clusterId === clusterId);
    if (!row) return;
    row.reviewed = true;
    this.revokeDecision(row.decisionId, "Undone from the auto-answer review list");
  }

  // ------------------------------------------------------------ metrics --

  private checkCircuit(): void {
    const stats = this.stats();
    const metrics = this.triageStore.readMetrics();
    if (stats.circuitOpen && !metrics.circuitNotified) {
      this.triageStore.updateMetrics((m) => void (m.circuitNotified = true));
      this.deps.notify(
        `Agent View Triage: auto-answer error rate is ${(stats.autoErrorRate * 100).toFixed(0)}% ` +
          `(ceiling ${ERROR_CEILING * 100}%). Auto-answer is running in dry run until the rate recovers — ` +
          `revoke the decisions that were wrong.`,
      );
    } else if (!stats.circuitOpen && metrics.circuitNotified) {
      this.triageStore.updateMetrics((m) => void (m.circuitNotified = false));
    }
  }

  stats(): TriageStats {
    const m = this.triageStore.readMetrics();
    const decisions = this.triageStore.listDecisions();
    // Derived, not counted: a decision that was used and then revoked or edited
    // is exactly one auto-answer error, and the rate recovers when the human
    // cleans it up.
    const errors = decisions.filter((d) => d.hitCount > 0 && (d.revokedAt || d.editedAt)).length;
    const autoErrorRate = m.autoAnswers > 0 ? errors / m.autoAnswers : 0;
    return {
      rawQuestions: m.rawQuestions,
      clustersAnswered: m.clustersAnswered,
      compression: m.rawQuestions > 0 ? m.clustersAnswered / m.rawQuestions : 0,
      autoAnswers: m.autoAnswers,
      autoHitRate: m.rawQuestions > 0 ? m.autoAnswers / m.rawQuestions : 0,
      autoErrorRate,
      medianHoldMs: median(m.holdMs),
      circuitOpen: m.autoAnswers >= ERROR_MIN_SAMPLE && autoErrorRate > ERROR_CEILING,
    };
  }

  /** Churn-based staleness (spec S6.2): the files a Decision scoped itself to
   *  have moved on substantially since it was made. A hint, never an expiry. */
  private async refreshStaleness(): Promise<void> {
    const decisions = this.triageStore.listDecisions().filter(
      (d) => !d.revokedAt && d.atCommit && d.scope.pathGlob && d.scope.repo,
    );
    let changed = false;
    for (const d of decisions) {
      try {
        const lines = await this.deps.churn(d.scope.repo!, d.atCommit!, d.scope.pathGlob);
        const hint =
          lines >= CHURN_STALE_LINES
            ? `${lines} lines changed under ${d.scope.pathGlob} since this was decided`
            : "";
        const prev = this.staleHints.get(d.id) || "";
        if (hint !== prev) {
          changed = true;
          if (hint) this.staleHints.set(d.id, hint);
          else this.staleHints.delete(d.id);
        }
      } catch {
        /* a repo that moved or vanished simply has no churn signal */
      }
    }
    if (changed) this._onDidChange.fire();
  }

  // --------------------------------------------------------- projection --

  /** Everything the Triage view renders, in the order it renders it. */
  buildState(): TriageState {
    const cfg = this.getConfig();
    const stats = this.stats();
    const open = [...this.clusters.values()].filter((c) => c.state === "open");
    const now = Date.now();

    const inbox: TriageRow[] = open
      .map((c) => ({
        id: c.id,
        kind: c.kind,
        category: c.norm.category,
        intent: c.norm.intent || c.members[0]?.text.slice(0, 120) || "(unreadable question)",
        scopeHint: c.norm.scopeHint,
        repo: c.context.repo,
        repoName: path.basename(c.context.repo) || c.context.repo,
        branch: c.context.branch || undefined,
        createdAt: c.createdAt,
        options: [...new Set(c.members.flatMap((m) => m.options || []))].slice(0, 8),
        waiting: c.members.map((m) => ({
          questionId: m.questionId,
          sessionId: m.sessionId,
          label: m.label,
          text: m.text,
          held: m.held,
          at: m.at,
        })),
        alsoInRepos: this.countOtherRepos(c, cfg.dedupThreshold),
        suggestion: c.suggestion,
      }))
      // Route (spec S5.2 step 4): conflicts, then permissions, then the ones
      // with the most sessions stuck behind them, then oldest first.
      .sort(
        (a, b) =>
          kindRank(a.kind) - kindRank(b.kind) ||
          b.waiting.length - a.waiting.length ||
          a.createdAt - b.createdAt,
      );

    const decisions: DecisionRow[] = this.triageStore.listDecisions().map((d) => ({
      ...d,
      expired: !!d.expiresAt && d.expiresAt <= now,
      staleReason:
        this.staleHints.get(d.id) ||
        (d.repeatedAfterAutoAnswer ? "A session re-asked this right after it was auto-answered" : undefined),
    }));

    return {
      enabled: cfg.enabled,
      ai: cfg.ai && !this.consentDeclined,
      autoAnswerEnabled: cfg.autoAnswerEnabled,
      dryRun: cfg.dryRun || stats.circuitOpen,
      holdEnabled: cfg.holdEnabled,
      hooksInstalled: this.deps.hooksInstalled(),
      defaultScope: cfg.defaultScope,
      defaultExpiry: cfg.defaultExpiry,
      inbox,
      auto: this.auto,
      decisions,
      stats,
    };
  }

  private countOtherRepos(cluster: StoredCluster, threshold: number): number {
    const repos = new Set<string>();
    for (const c of this.clusters.values()) {
      if (c === cluster || c.state !== "open") continue;
      if (c.context.repo === cluster.context.repo) continue;
      if (similarity(cluster.fp, c.fp) >= threshold) repos.add(c.context.repo);
    }
    return repos.size;
  }

  // ------------------------------------------------------------ helpers --

  /** Drop members whose session moved on, and clusters that emptied out. */
  private prune(byId: Map<string, AgentSession>, liveConflicts: Set<string>): void {
    for (const [id, cluster] of [...this.clusters]) {
      if (cluster.kind === "conflict") {
        if (!liveConflicts.has(id)) this.clusters.delete(id);
        continue;
      }
      cluster.members = cluster.members.filter((m) => {
        if (this.holds.isHeld(m.questionId)) return true;
        const s = byId.get(m.sessionId);
        return !!s && (s.status === "waiting" || s.status === "error");
      });
      if (cluster.members.length === 0) this.clusters.delete(id);
    }
    for (const [sessionId, rec] of this.recentAuto) {
      if (Date.now() - rec.at > REPEAT_WINDOW_MS) this.recentAuto.delete(sessionId);
    }
    for (const sessionId of this.scanned.keys()) {
      if (!byId.has(sessionId)) this.scanned.delete(sessionId);
    }
  }

  /**
   * Step 1 — Normalize. The rules pass always runs (it is what the lexical
   * prefilter and the offline fallback need); Claude then sharpens the `intent`
   * line the human reads and the shortlist is ranked on.
   */
  private async normalize(q: Question): Promise<NormalizedQuestion> {
    const rules = normalizeQuestion(q.intentText || q.text, {
      permission: q.kind === "permission",
      options: q.options,
    });
    const cfg = this.getConfig();
    if (q.kind === "conflict") return rules; // we wrote that text; nothing to restate
    if (!(await this.aiAvailable(cfg))) return rules;

    const parsed = await judgeNormalize(q.intentText || q.text, this.judgeOptions(cfg));
    if (!parsed) return rules; // offline or bad output — the rules pass stands
    return {
      intent: stripMarkdown(parsed.intent).toLowerCase().slice(0, 160),
      category: CATEGORIES.includes(parsed.category as QuestionCategory)
        ? (parsed.category as QuestionCategory)
        : rules.category,
      entities: Array.isArray(parsed.entities)
        ? parsed.entities.map((e) => String(e).toLowerCase()).slice(0, 12)
        : rules.entities,
      scopeHint: rules.scopeHint,
    };
  }
}

const CATEGORIES: QuestionCategory[] = [
  "tooling",
  "convention",
  "scope",
  "permission",
  "design",
  "other",
];

function kindRank(k: Cluster["kind"]): number {
  return k === "conflict" ? 0 : k === "permission" ? 1 : 2;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function expiryToTimestamp(expiry: AnswerExpiry): number | undefined {
  if (expiry === "forever" || expiry === "once") return undefined;
  if (expiry === "week") return Date.now() + 7 * 24 * 3600_000;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return end.getTime();
}

function toDecisionScope(scope: AnswerScope, cluster: Cluster): Decision["scope"] {
  switch (scope) {
    case "session":
      return { repo: cluster.context.repo, sessionId: cluster.members[0]?.sessionId };
    case "branch":
      return { repo: cluster.context.repo, branch: cluster.context.branch || undefined };
    case "repo":
      return { repo: cluster.context.repo };
    case "global":
      return {};
  }
}

/**
 * Scope matching (spec S6.1): every field the Decision set must be satisfied
 * by the Question's context; unset fields are wildcards.
 */
export function scopeCovers(scope: Decision["scope"], q: Question): boolean {
  if (scope.repo && scope.repo !== q.context.repo) return false;
  if (scope.sessionId && scope.sessionId !== q.sessionId) return false;
  if (scope.branch && !globMatch(scope.branch, q.context.branch)) return false;
  if (scope.pathGlob) {
    const rel = q.context.files.map((f) =>
      path.isAbsolute(f) ? path.relative(q.context.repo, f) : f,
    );
    if (!rel.some((f) => globMatch(scope.pathGlob!, f))) return false;
  }
  return true;
}

/** Local copy of Conflict Radar's pairing, so Triage works with the AI-free
 *  Conflict Radar setting off — it only needs the file collisions, not the panel. */
function computeFileConflicts(sessions: AgentSession[]): Conflict[] {
  const byFile = new Map<string, { sessionId: string; label: string }[]>();
  for (const s of sessions) {
    for (const file of s.filesTouched || []) {
      const arr = byFile.get(file) ?? [];
      if (!arr.some((a) => a.sessionId === s.sessionId)) {
        arr.push({ sessionId: s.sessionId, label: s.label });
        byFile.set(file, arr);
      }
    }
  }
  const out: Conflict[] = [];
  for (const [file, agents] of byFile) if (agents.length >= 2) out.push({ file, agents });
  return out.sort((a, b) => b.agents.length - a.agents.length).slice(0, 10);
}
