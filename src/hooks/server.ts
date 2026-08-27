import * as http from "http";
import { AgentStatus } from "../types";

export const HOOK_PATH = "/mas-hook";
/** Triage's blocking channel: this request is held open until a human answers. */
export const TRIAGE_PATH = "/mas-triage";

/** Map a Claude Code hook event to an agent status. */
export function mapHookEvent(event: any): AgentStatus | undefined {
  const name: string = event?.hook_event_name || event?.hookEventName || "";
  switch (name) {
    case "UserPromptSubmit":
    case "PreToolUse":
    case "PostToolUse":
    case "SessionStart":
    case "SubagentStart":
      return "running";
    case "Notification": {
      const t: string = event?.notification_type || "";
      // permission / idle prompts mean the agent is blocked on the user
      if (t.includes("permission") || t.includes("idle") || t === "") return "waiting";
      return "running";
    }
    case "PostToolUseFailure":
      return "error";
    case "Stop":
    case "SubagentStop":
      return "idle";
    case "SessionEnd":
      return "done";
    case "TeammateIdle":
    case "TaskCreated":
    case "TaskCompleted":
      // Team events describe a teammate/task, not this session's own state —
      // surfaced via onEvent (live phrase + cockpit refresh), never as status.
      return undefined;
    default:
      return undefined;
  }
}

export interface HookSink {
  applyHookStatus(sessionId: string, status: AgentStatus): void;
}

/**
 * Triage's hold channel. Resolves with the human's answer (fed back to the
 * agent as the tool result) or null to let Claude Code prompt as it normally
 * would. It must always settle — the hook is blocking a real agent.
 */
export type TriageHold = (event: any) => Promise<string | null>;

/**
 * Lightweight HTTP server that receives Claude Code hook events (POSTed by the
 * installed hook command) and forwards status to the store. Binds to loopback
 * only.
 */
export class HookServer {
  private server?: http.Server;

  constructor(
    private readonly sink: HookSink,
    private readonly onEvent?: (event: any) => void,
    private readonly triageHold?: TriageHold,
  ) {}

  start(port: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => this.handle(req, res));
      this.server.on("error", reject);
      this.server.listen(port, "127.0.0.1", () => resolve());
    });
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const triage = !!req.url?.startsWith(TRIAGE_PATH);
    if (req.method !== "POST" || !(triage || req.url?.startsWith(HOOK_PATH))) {
      res.writeHead(404);
      res.end();
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (size > 5 * 1024 * 1024) {
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      let event: any;
      try {
        event = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(200);
        res.end();
        return; // malformed event — answer the curl and drop it
      }
      if (triage) {
        this.handleTriage(event, res);
        return;
      }
      res.writeHead(200);
      res.end("ok");
      try {
        const sessionId = event?.session_id || event?.sessionId;
        const status = mapHookEvent(event);
        if (sessionId && status) this.sink.applyHookStatus(sessionId, status);
        this.onEvent?.(event);
      } catch {
        /* a listener throwing must not take the hook server down */
      }
    });
  }

  /**
   * Hold the hook open until Triage has an answer, then reply with a PreToolUse
   * decision that hands it to the agent. An empty body (no Triage, no answer,
   * anything unexpected) is a no-op hook, so Claude Code prompts as usual —
   * the failure mode of a hold is always "behaves like today".
   */
  private handleTriage(event: any, res: http.ServerResponse): void {
    const settle = (answer: string | null) => {
      if (res.writableEnded) return;
      if (!answer) {
        res.writeHead(200);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: answer,
          },
        }),
      );
    };
    // The agent gave up on us (Ctrl-C, hook timeout) — stop holding.
    res.on("close", () => settle(null));
    if (!this.triageHold) {
      settle(null);
      return;
    }
    this.triageHold(event).then(settle, () => settle(null));
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
  }
}
