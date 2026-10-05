import * as vscode from "vscode";
import { AgentSession, AgentStatus } from "../types";
import { AgentStore } from "../store";
import { PriceOverrides, priceUsageMap } from "../pricing";

export type { ModelPrice } from "../pricing";

export interface UnattendedConfig {
  enabled: boolean;
  /** A managed agent idle-but-not-done this long is nudged to continue. */
  nudgeStuckAfterSeconds: number;
  /** Cap on consecutive nudges before we stop and escalate to the human. */
  maxNudges: number;
  /** Per-agent estimated-cost cap in USD; the agent is paused past it. 0 = off. */
  maxCostUsd: number;
  /** Per-family price overrides (mas.unattended.pricing); list prices otherwise. */
  pricing: PriceOverrides;
}

/** Side effects the controller drives, wired by the extension host. */
export interface UnattendedActions {
  /** Push a "keep going" prompt into the agent's terminal. */
  nudge(sessionId: string): boolean;
  /** Interrupt + stop a managed agent (its branch/diff are kept). */
  pause(sessionId: string): void;
  notify(message: string): void;
}

/**
 * Estimated USD for a session and its subagents: every API message's billed
 * usage (see usage.ts) at list prices, or at the user's per-family overrides.
 * Matches Claude Code's own /cost at list prices; an estimate only for plans
 * with negotiated rates.
 */
export function estimateCostUsd(a: AgentSession, pricing: PriceOverrides): number {
  if (Object.keys(pricing).length === 0 && a.costUsd !== undefined) return a.costUsd;
  return (
    priceUsageMap(a.usage, pricing) +
    (a.subagents || []).reduce((sum, s) => sum + priceUsageMap(s.usage, pricing), 0)
  );
}

interface NudgeState {
  count: number;
  lastNudgeAt: number;
  /** plan.done captured at the last nudge. We re-arm only when it actually
   *  advances — the nudge prompt itself is a transcript line that bumps
   *  lastActivity, so activity can't be used to tell whether the nudge worked. */
  doneAtNudge: number;
}

function isActive(s: AgentStatus): boolean {
  return s === "running" || s === "thinking" || s === "waiting";
}

/**
 * Governed auto-pilot for a fleet of MANAGED agents (never touches external
 * sessions we don't own). When enabled it:
 *   - nudges a stuck agent (idle with an unfinished plan) to keep going, capped
 *     so it can't loop forever; after the cap it escalates to the human;
 *   - pauses an agent whose estimated cost passes the per-agent cap;
 *   - leaves "waiting" (needs-you) escalation to the existing notifications.
 */
export class UnattendedController {
  private readonly nudges = new Map<string, NudgeState>();
  private readonly paused = new Set<string>();
  private readonly escalated = new Set<string>();
  private sub?: vscode.Disposable;

  constructor(
    private readonly store: AgentStore,
    private readonly getConfig: () => UnattendedConfig,
    private readonly actions: UnattendedActions,
  ) {}

  start(): void {
    this.sub = this.store.onDidChange(() => this.onChange());
  }

  dispose(): void {
    this.sub?.dispose();
    this.nudges.clear();
    this.paused.clear();
    this.escalated.clear();
  }

  /** Total estimated USD across the MANAGED fleet — the same population the
   *  per-agent cost cap governs (shown in the status-bar Fleet Pulse). */
  fleetCostUsd(): number {
    const cfg = this.getConfig();
    let total = 0;
    for (const a of this.store.list()) {
      if (a.kind !== "session" || !a.managed) continue;
      total += estimateCostUsd(a, cfg.pricing);
    }
    return total;
  }

  private onChange(): void {
    const cfg = this.getConfig();
    const live = new Set<string>();
    for (const a of this.store.list()) {
      if (a.kind !== "session" || !a.managed) continue; // only agents we own
      live.add(a.sessionId);
      if (!cfg.enabled) continue;

      // Cost cap — pause once past the per-agent budget.
      if (cfg.maxCostUsd > 0 && !this.paused.has(a.sessionId)) {
        const cost = estimateCostUsd(a, cfg.pricing);
        if (cost > cfg.maxCostUsd) {
          this.paused.add(a.sessionId);
          if (isActive(a.status)) this.actions.pause(a.sessionId);
          this.actions.notify(
            `Unattended: paused ${a.label} — estimated cost $${cost.toFixed(2)} hit the $${cfg.maxCostUsd.toFixed(2)} cap.`,
          );
          continue;
        }
      }

      if (this.paused.has(a.sessionId)) continue;
      this.maybeNudge(a, cfg);
    }

    // Bounded growth — forget agents that aged out of discovery.
    for (const id of this.nudges.keys()) if (!live.has(id)) this.nudges.delete(id);
    for (const id of this.paused) if (!live.has(id)) this.paused.delete(id);
    for (const id of this.escalated) if (!live.has(id)) this.escalated.delete(id);
  }

  private maybeNudge(a: AgentSession, cfg: UnattendedConfig): void {
    // The human explicitly set this one aside — don't auto-prompt it.
    if (a.acknowledged) return;
    const plan = a.plan;
    // Only a stalled, mid-plan agent qualifies: idle (not done/running), with an
    // unfinished plan, quiet for a while. "waiting" is a real ask -> leave it to
    // notifications; "done"/no-plan means finished -> never nudge.
    if (a.status !== "idle" || !plan || plan.total === 0 || plan.done >= plan.total) return;
    const staleMs = Math.max(5, cfg.nudgeStuckAfterSeconds) * 1000;
    if (Date.now() - a.lastActivity < staleMs) return;

    let st = this.nudges.get(a.sessionId);
    // A nudge "worked" only if the plan actually advanced. Do NOT key off
    // lastActivity: the nudge prompt itself is a transcript line that bumps it,
    // so that would reset the counter every cycle and maxNudges (plus the human
    // escalation) would never trigger.
    if (st && plan.done > st.doneAtNudge) {
      st = undefined;
      this.escalated.delete(a.sessionId);
    }
    if (!st) st = { count: 0, lastNudgeAt: 0, doneAtNudge: plan.done };

    if (st.count >= cfg.maxNudges) {
      if (!this.escalated.has(a.sessionId)) {
        this.escalated.add(a.sessionId);
        this.actions.notify(
          `Unattended: ${a.label} is stuck — ${st.count} nudge${st.count === 1 ? "" : "s"} didn't advance its plan. Over to you.`,
        );
      }
      this.nudges.set(a.sessionId, st);
      return;
    }
    if (Date.now() - st.lastNudgeAt < staleMs) {
      this.nudges.set(a.sessionId, st);
      return;
    }

    if (this.actions.nudge(a.sessionId)) {
      st.count += 1;
      st.lastNudgeAt = Date.now();
      st.doneAtNudge = plan.done;
      this.nudges.set(a.sessionId, st);
    }
  }
}
