import * as vscode from "vscode";
import * as fs from "fs";
import { AgentSession, AgentStatus } from "./types";
import { discoverAgents } from "./discovery";
import { projectsDir } from "./paths";
import { Registry } from "./orchestrator/registry";
import { agentNameForBranch } from "./orchestrator/naming";
import { isLive, LiveSession, readSessionRegistry, sessionRegistryDir } from "./sessionRegistry";

interface HookState {
  status: AgentStatus;
  at: number;
}

interface LiveActionState {
  action: string;
  at: number;
}

/** A hook status older than this is no longer trusted (fall back to JSONL). */
const HOOK_STATUS_TTL_MS = 45_000;
/** A live "now doing X" phrase older than this is dropped (tool likely done). */
const LIVE_ACTION_TTL_MS = 20_000;
/** Periodic re-evaluation so stale statuses + relative times stay current. */
const HEARTBEAT_MS = 15_000;

function isActiveStatus(s: AgentStatus): boolean {
  return s === "running" || s === "thinking" || s === "waiting";
}

/** A status that asks for the user — the thing "needs you" is built from. */
function isNeedsYou(s: AgentStatus): boolean {
  return s === "waiting" || s === "error";
}

/**
 * Fold Claude Code's live session state into a discovered session. Returns the
 * time the status was set when it applied (for the hook-vs-registry race), or
 * undefined when the entry is too stale to trust.
 *
 * The registry knows busy / idle / waiting; the transcript knows finer shades
 * (thinking, error, "ended on a question"), so the registry only overrides
 * what it contradicts: busy lifts a quiet session to running, idle ends a
 * stale running/thinking, waiting always wins and says what it waits on.
 */
function applyRegistry(a: AgentSession, r: LiveSession, now: number): number | undefined {
  a.sessionName = r.name || a.sessionName;
  a.sessionKind = r.kind === "background" ? "background" : "interactive";
  a.entrypoint = r.entrypoint;
  if (!isLive(r, now)) {
    // The process is verifiably gone: whatever the transcript's recency
    // window says, nobody is running this session any more.
    if (r.alive === false && (a.status === "running" || a.status === "thinking") && now - a.lastActivity > 5000) {
      a.status = "idle";
    }
    return undefined;
  }
  if (!r.status) return undefined;
  const subsBusy = (a.subagents || []).some(
    (s) => s.status === "running" || s.status === "waiting" || s.status === "thinking",
  );
  if (r.status === "waiting") {
    a.status = "waiting";
    a.waitingFor = r.waitingFor;
  } else if (r.status === "busy") {
    if (a.status !== "running" && a.status !== "thinking") a.status = "running";
  } else if ((a.status === "running" || a.status === "thinking") && !subsBusy) {
    a.status = "idle";
  }
  a.statusSource = "registry";
  return r.statusUpdatedAt;
}

/**
 * Central source of truth for the agent fleet. Merges on-disk discovery
 * (pull) with hook events (push), and emits a change whenever either updates.
 */
export class AgentStore {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private agents: AgentSession[] = [];
  private readonly hookStatus = new Map<string, HookState>();
  private readonly liveAction = new Map<string, LiveActionState>();
  // Sessions the user manually dismissed from "needs you", keyed to the
  // lastActivity at dismiss time — so the dismissal auto-clears (re-arms) the
  // moment the agent does anything new.
  private readonly acks = new Map<string, number>();
  private watcher?: fs.FSWatcher;
  private registryWatcher?: fs.FSWatcher;
  private pollTimer?: NodeJS.Timeout;
  private heartbeat?: NodeJS.Timeout;
  private debounce?: NodeJS.Timeout;
  private showOlder = false;

  constructor(
    private readonly registry: Registry,
    private readonly getConfig: () => { recentDays: number; recentHours: number; sessionRegistry: boolean },
  ) {}

  start(): void {
    this.refresh();
    this.watch();
    this.heartbeat = setInterval(() => this.refresh(), HEARTBEAT_MS);
  }

  dispose(): void {
    this.watcher?.close();
    this.registryWatcher?.close();
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.debounce) clearTimeout(this.debounce);
    this._onDidChange.dispose();
  }

  list(): AgentSession[] {
    return this.agents;
  }

  getById(id: string): AgentSession | undefined {
    for (const a of this.agents) {
      if (a.sessionId === id) return a;
      const sub = a.subagents?.find((s) => s.sessionId === id);
      if (sub) return sub;
    }
    return undefined;
  }

  get showingOlder(): boolean {
    return this.showOlder;
  }

  setShowOlder(v: boolean): void {
    if (this.showOlder === v) return;
    this.showOlder = v;
    this._onDidChange.fire();
  }

  /**
   * Top-level sessions to *display*: active ones always, plus those active
   * within the display window (mas.recentHours). Older idle sessions are hidden
   * until the user reveals them. The full set stays in list() so notifications,
   * conflict detection and lookups still see everything.
   */
  listVisible(): AgentSession[] {
    if (this.showOlder) return this.agents;
    const winMs = Math.max(1, this.getConfig().recentHours) * 3_600_000;
    const now = Date.now();
    return this.agents.filter((a) => isActiveStatus(a.status) || now - a.lastActivity <= winMs);
  }

  hiddenCount(): number {
    return this.showOlder ? 0 : this.agents.length - this.listVisible().length;
  }

  refresh(): void {
    const cfg = this.getConfig();
    const found = discoverAgents({
      recentDays: cfg.recentDays,
      managedLookup: (id) => {
        const m = this.registry.get(id);
        return m
          ? {
              worktreePath: m.worktreePath,
              label: m.label,
              groupId: m.groupId,
              groupRole: m.groupRole,
              spawnName: agentNameForBranch(m.branch),
            }
          : undefined;
      },
    });

    // Claude Code's live session registry (zero-config, covers sessions the
    // hooks never see: other windows, background jobs, older hook installs).
    const now = Date.now();
    const registry = cfg.sessionRegistry ? readSessionRegistry() : undefined;
    const registryAt = new Map<string, number>();
    if (registry) {
      for (const a of found) {
        const r = registry.get(a.sessionId);
        if (!r) continue;
        const at = applyRegistry(a, r, now);
        if (at !== undefined) registryAt.set(a.sessionId, at);
      }
    }

    // Hook status is authoritative over the JSONL heuristic, EXCEPT when it's
    // stale or the transcript shows newer activity. Without the matching Stop
    // (server restart, missed event, port held by another window, or a session
    // resumed via a path the hook server never saw) a hook status would
    // otherwise pin the agent forever — including terminal idle/done/error.
    // Against the registry, whichever changed more recently wins.
    const liveIds = new Set<string>();
    for (const a of found) {
      liveIds.add(a.sessionId);
      const hs = this.hookStatus.get(a.sessionId);
      if (!hs) continue;
      const stale = now - hs.at > HOOK_STATUS_TTL_MS;
      const supersededByJsonl = a.lastActivity > hs.at + 1000;
      if (stale || supersededByJsonl) {
        this.hookStatus.delete(a.sessionId); // forget it; rely on the heuristic
        continue;
      }
      const regAt = registryAt.get(a.sessionId);
      if (regAt !== undefined && regAt >= hs.at) continue;
      a.status = hs.status;
      a.statusSource = "hook";
      if (hs.status !== "waiting") a.waitingFor = undefined;
    }

    // Carry the live hook-driven "now doing X" phrase across rediscovery
    // (discovery rebuilds the AgentSession objects from disk each time).
    for (const a of found) {
      const la = this.liveAction.get(a.sessionId);
      if (la && Date.now() - la.at <= LIVE_ACTION_TTL_MS) a.liveAction = la.action;
    }

    // Apply manual "needs you" dismissals, and auto-clear them once the agent
    // is no longer asking (status changed) or has done something new (activity
    // advanced past the dismiss point) — so a genuine new ask resurfaces. A
    // dismissed agent presents as plain idle: the real (waiting/error) status
    // is only read here for the re-arm test, then overridden.
    for (const a of found) {
      const ackAt = this.acks.get(a.sessionId);
      if (ackAt === undefined) continue;
      if (!isNeedsYou(a.status) || a.lastActivity > ackAt) {
        this.acks.delete(a.sessionId);
      } else {
        this.applyDismissed(a);
      }
    }

    // Prune map entries for sessions that have aged out of discovery so the
    // hookStatus / liveAction maps don't grow unbounded over the host lifetime.
    for (const [id, hs] of this.hookStatus) {
      if (!liveIds.has(id) && Date.now() - hs.at > HOOK_STATUS_TTL_MS) this.hookStatus.delete(id);
    }
    for (const [id, la] of this.liveAction) {
      if (!liveIds.has(id) || Date.now() - la.at > LIVE_ACTION_TTL_MS) this.liveAction.delete(id);
    }
    for (const id of this.acks.keys()) if (!liveIds.has(id)) this.acks.delete(id);

    this.agents = found;
    this._onDidChange.fire();
  }

  /** Present a dismissed agent as plain idle (status + error reason cleared). */
  private applyDismissed(a: AgentSession): void {
    a.acknowledged = true;
    a.status = "idle";
    a.lastError = undefined;
    a.waitingFor = undefined;
  }

  /** Manually dismiss an agent from "needs you" until it next does something. */
  acknowledge(sessionId: string): void {
    const a = this.getById(sessionId);
    if (a && !isNeedsYou(a.status)) return; // nothing to dismiss
    this.acks.set(sessionId, a ? a.lastActivity : Date.now());
    if (a) this.applyDismissed(a);
    this._onDidChange.fire();
  }

  /** Undo a dismissal — let the agent show as "needs you" again. */
  unacknowledge(sessionId: string): void {
    if (!this.acks.delete(sessionId)) return;
    const a = this.getById(sessionId);
    if (a) a.acknowledged = false;
    this.refresh(); // re-read the real status it was hiding
  }

  /** Dismiss every agent currently asking for the user. Returns the count. */
  acknowledgeAllNeedsYou(): number {
    let n = 0;
    for (const a of this.agents) {
      if (isNeedsYou(a.status) && !a.acknowledged) {
        this.acks.set(a.sessionId, a.lastActivity);
        this.applyDismissed(a);
        n++;
      }
    }
    if (n) this._onDidChange.fire();
    return n;
  }

  isAcknowledged(sessionId: string): boolean {
    return !!this.getById(sessionId)?.acknowledged;
  }

  /** Sessions still asking for the user (after dismissals). */
  needsYouCount(): number {
    return this.agents.filter((a) => isNeedsYou(a.status) && !a.acknowledged).length;
  }

  /** Called by the hook server when a Claude Code event arrives. */
  applyHookStatus(sessionId: string, status: AgentStatus): void {
    this.hookStatus.set(sessionId, { status, at: Date.now() });
    // A fresh hook-driven ask is a new attention signal — drop any prior
    // dismissal so it resurfaces.
    if (isNeedsYou(status)) this.acks.delete(sessionId);
    const a = this.agents.find((x) => x.sessionId === sessionId);
    if (a) {
      a.status = status;
      a.statusSource = "hook";
      a.acknowledged = false;
      if (status !== "waiting") a.waitingFor = undefined;
      this._onDidChange.fire();
    } else {
      this.scheduleRefresh();
    }
  }

  /**
   * Update the live "now doing X" phrase for a session (from a hook tool event).
   * Pass `undefined` to clear it (e.g. on Stop). Only fires a change when the
   * phrase actually changes, so a burst of tool events doesn't storm the UI.
   */
  applyLiveAction(sessionId: string, action: string | undefined): void {
    const prev = this.liveAction.get(sessionId)?.action;
    if (action) {
      this.liveAction.set(sessionId, { action, at: Date.now() });
    } else {
      this.liveAction.delete(sessionId);
    }
    if ((prev || undefined) === (action || undefined)) return; // no visible change
    const a = this.agents.find((x) => x.sessionId === sessionId);
    if (a) {
      a.liveAction = action;
      this._onDidChange.fire();
    }
  }

  private watch(): void {
    try {
      this.watcher = fs.watch(projectsDir(), { recursive: true }, () => this.scheduleRefresh());
    } catch {
      // Recursive fs.watch is unsupported on Linux — fall back to polling.
      this.pollTimer = setInterval(() => this.refresh(), 4000);
    }
    // A status flip (busy -> waiting) rewrites only the registry entry, not the
    // transcript, so watch it too. Flat directory: no recursion needed. Absent
    // on older CLIs — the heartbeat still covers everything.
    try {
      this.registryWatcher = fs.watch(sessionRegistryDir(), () => {
        if (this.getConfig().sessionRegistry) this.scheduleRefresh();
      });
    } catch {
      /* no registry directory */
    }
  }

  private scheduleRefresh(): void {
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => this.refresh(), 400);
  }
}
