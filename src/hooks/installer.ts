import * as fs from "fs";
import { settingsPath } from "../paths";
import { HOOK_PATH, TRIAGE_PATH } from "./server";

/** Unique tokens used to find/remove only MAS-owned hooks. */
const MARKERS = [HOOK_PATH, TRIAGE_PATH]; // both appear in our command strings

const TOOL_EVENTS = ["PreToolUse", "PostToolUse", "PostToolUseFailure"];
const PLAIN_EVENTS = [
  "UserPromptSubmit",
  "Notification",
  "Stop",
  "SubagentStop",
  "SessionStart",
  "SessionEnd",
  // Agent Teams events (2.1.x, experimental) — ignored by older CLIs, so
  // installing them unconditionally is safe.
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
];

interface HookEntry {
  type: "command";
  command: string;
  /** Seconds Claude Code waits for this hook. Only Triage's hold needs one. */
  timeout?: number;
}
interface HookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

function buildCommand(port: number): string {
  // Reads the hook event JSON on stdin and POSTs it to the MAS hook server.
  return (
    `curl -sS -m 2 -X POST -H 'content-type: application/json' ` +
    `--data-binary @- http://127.0.0.1:${port}${HOOK_PATH} >/dev/null 2>&1 || true`
  );
}

/**
 * Triage's Hold hook. Unlike every other MAS hook this one KEEPS ITS STDOUT:
 * the server replies with a PreToolUse decision carrying the human's answer,
 * and Claude Code reads it off stdout. It also blocks for up to `holdSeconds`
 * while the question sits in the Triage inbox.
 *
 * Every failure path prints nothing and exits 0 — extension not running, port
 * taken, hold expired — which Claude Code treats as "no decision" and prompts
 * the user itself. A hold can therefore only ever delay a prompt, never lose it.
 */
function buildTriageCommand(port: number, holdSeconds: number): string {
  return (
    `curl -s -m ${holdSeconds + 5} -X POST -H 'content-type: application/json' ` +
    `--data-binary @- http://127.0.0.1:${port}${TRIAGE_PATH} 2>/dev/null || true`
  );
}

function readSettings(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(settingsPath(), "utf8"));
  } catch (e: any) {
    if (e?.code === "ENOENT") return {};
    throw new Error(`Could not parse ${settingsPath()}: ${e.message}`);
  }
}

function isMasGroup(g: HookGroup): boolean {
  return (g.hooks || []).some(
    (h) => typeof h.command === "string" && MARKERS.some((m) => h.command.includes(m)),
  );
}

function stripMas(groups: HookGroup[] | undefined): HookGroup[] {
  return (groups || []).filter((g) => !isMasGroup(g));
}

export interface HookInstallOptions {
  /** Install Triage's blocking AskUserQuestion hook (mas.triage.hold.enabled). */
  hold?: boolean;
  /** How long a held question may park before Claude Code prompts instead. */
  holdSeconds?: number;
}

/** Idempotently install MAS hooks for the given port. Returns the settings path. */
export function installHooks(port: number, opts: HookInstallOptions = {}): string {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = settings.hooks || {};
  const command = buildCommand(port);

  for (const event of TOOL_EVENTS) {
    hooks[event] = stripMas(hooks[event]);
    hooks[event].push({ matcher: "*", hooks: [{ type: "command", command }] });
  }
  for (const event of PLAIN_EVENTS) {
    hooks[event] = stripMas(hooks[event]);
    hooks[event].push({ hooks: [{ type: "command", command }] });
  }

  // A second, narrower PreToolUse group. It runs alongside the "*" one above
  // (which discards its output and decides nothing), so ordering is irrelevant.
  if (opts.hold) {
    const holdSeconds = Math.max(5, opts.holdSeconds ?? 300);
    hooks.PreToolUse.push({
      matcher: "AskUserQuestion",
      hooks: [
        { type: "command", command: buildTriageCommand(port, holdSeconds), timeout: holdSeconds + 10 },
      ],
    });
  }

  settings.hooks = hooks;
  writeSettings(settings);
  return settingsPath();
}

/** True when the installed hooks include Triage's blocking Hold hook. */
export function holdHookInstalled(): boolean {
  const hooks: Record<string, HookGroup[]> = readSettings().hooks || {};
  return (hooks.PreToolUse || []).some((g) =>
    (g.hooks || []).some((h) => typeof h.command === "string" && h.command.includes(TRIAGE_PATH)),
  );
}

/** Remove only MAS-owned hooks, leaving the user's own hooks intact. */
export function removeHooks(): string {
  const settings = readSettings();
  const hooks: Record<string, HookGroup[]> = settings.hooks || {};
  for (const event of Object.keys(hooks)) {
    const cleaned = stripMas(hooks[event]);
    if (cleaned.length === 0) delete hooks[event];
    else hooks[event] = cleaned;
  }
  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  writeSettings(settings);
  return settingsPath();
}

export function hooksInstalled(): boolean {
  const hooks: Record<string, HookGroup[]> = readSettings().hooks || {};
  return Object.values(hooks).some((groups) => (groups || []).some(isMasGroup));
}

function writeSettings(settings: Record<string, any>): void {
  const p = settingsPath();
  // Safety: back up the user's settings before the first mutation.
  try {
    if (fs.existsSync(p) && !fs.existsSync(p + ".mas-backup")) {
      fs.copyFileSync(p, p + ".mas-backup");
    }
  } catch {
    /* best effort */
  }
  fs.writeFileSync(p, JSON.stringify(settings, null, 2) + "\n", "utf8");
}
