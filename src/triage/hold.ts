/**
 * Hold: a session parked inside a blocking Claude Code hook until the human
 * answers (spec S5.4). The hook command is a `curl` that keeps its HTTP
 * request open; this registry owns the un-resolved promise for each one.
 *
 * Every hold is bounded. On timeout it resolves `null`, the hook server replies
 * with an empty body, and Claude Code falls straight through to its own
 * prompt — so the worst case of a hold is exactly today's behaviour, never a
 * wedged agent.
 */
export class HoldRegistry {
  private readonly pending = new Map<
    string,
    { sessionId: string; resolve: (answer: string | null) => void; timer: NodeJS.Timeout; at: number }
  >();

  /** Park a question. Resolves with the answer, or null on timeout/cancel. */
  hold(questionId: string, sessionId: string, timeoutMs: number): Promise<string | null> {
    this.release(questionId, null); // a re-ask supersedes any earlier hold
    return new Promise<string | null>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(questionId);
        resolve(null);
      }, timeoutMs);
      this.pending.set(questionId, { sessionId, resolve, timer, at: Date.now() });
    });
  }

  isHeld(questionId: string): boolean {
    return this.pending.has(questionId);
  }

  /** How long this question has been parked (0 when it isn't). */
  heldForMs(questionId: string): number {
    const p = this.pending.get(questionId);
    return p ? Date.now() - p.at : 0;
  }

  /** Resume a parked session. Returns false when nothing was waiting. */
  release(questionId: string, answer: string | null): boolean {
    const p = this.pending.get(questionId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(questionId);
    p.resolve(answer);
    return true;
  }

  /** Release every hold for one session (it stopped, or was cleaned up). */
  releaseSession(sessionId: string): void {
    for (const [id, p] of [...this.pending]) if (p.sessionId === sessionId) this.release(id, null);
  }

  /** Let every parked session fall through to its own prompt (host shutdown). */
  dispose(): void {
    for (const id of [...this.pending.keys()]) this.release(id, null);
  }
}
