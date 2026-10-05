import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { claudeHome } from "./paths";

/**
 * Claude Code's own live-session registry: one `~/.claude/sessions/<pid>.json`
 * per running process (interactive, background, VS Code, SDK), rewritten as
 * the session's state changes. It is what `claude agents --json` and
 * ListAgents read, and it carries the one thing a transcript can't: whether the
 * session is busy, idle, or blocked on the user — and on what.
 *
 * Observed shape (2.1.289): { pid, sessionId, cwd, startedAt, version, kind,
 * entrypoint, pidDomain, name, nameSource, status: "busy"|"idle"|"waiting",
 * waitingFor?, updatedAt, statusUpdatedAt, messagingSocketPath, ... }.
 *
 * READ-ONLY, like every ~/.claude store. The `<pid>.<hash>.key` files beside
 * these hold peer tokens and are never opened. Entries from processes that
 * died uncleanly linger, so liveness is checked where the pid is ours to check
 * and freshness is required where it isn't. A live pid is not enough on its
 * own — the OS reuses them — so its start time must also match the entry's
 * `procStart`, the same test Claude Code applies.
 */

export type LiveStatus = "busy" | "idle" | "waiting";

export interface LiveSession {
  sessionId: string;
  pid: number;
  status?: LiveStatus;
  /** What a waiting session is blocked on, as Claude Code words it. */
  waitingFor?: string;
  name?: string;
  /** "derived" when Claude Code made the name up from the cwd. */
  nameSource?: string;
  kind?: string;
  entrypoint?: string;
  updatedAt: number;
  statusUpdatedAt: number;
  /** Process start as Claude Code recorded it: a UTC `ps -o lstart` string on
   *  macOS, jiffies since boot (/proc/<pid>/stat field 22) on Linux. */
  procStart?: string;
  /** true/false when the pid could be checked; undefined for another pid domain
   *  (e.g. a session in a Linux sandbox or container). */
  alive?: boolean;
}

/** `<pid>.json` only — never the `.key` files. */
const ENTRY_FILE = /^\d+\.json$/;

/** An entry whose pid can't be checked is only trusted while this fresh. */
export const UNVERIFIED_FRESH_MS = 10 * 60_000;

let localDomain: string | undefined;

/** The pid domain Claude Code would record for a process on this host:
 *  "darwin" / "win32", or "linux:<machine-id>:pid:[<ns>]" on Linux. */
function localPidDomain(): string {
  if (localDomain !== undefined) return localDomain;
  localDomain = process.platform;
  if (process.platform === "linux") {
    try {
      const machineId = fs.readFileSync("/etc/machine-id", "utf8").trim();
      const ns = fs.readlinkSync("/proc/self/ns/pid");
      localDomain = `linux:${machineId}:${ns}`;
    } catch {
      localDomain = "linux:?";
    }
  }
  return localDomain;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM"; // exists, owned by someone else
  }
}

/** Start times read back from the OS, cached briefly per pid (one `ps` spawn
 *  per minute at most on macOS, however often the fleet refreshes). */
const START_CACHE_MS = 60_000;
const startCache = new Map<number, { start?: string; at: number }>();

function normStart(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

/** macOS: one batched `ps` for every pid not cached. Missing pids are simply
 *  absent from the output (ps then exits 1, which is fine). */
function darwinStarts(pids: number[]): void {
  let raw = "";
  try {
    raw = execFileSync("ps", ["-o", "pid=,lstart=", "-p", pids.join(",")], {
      encoding: "utf8",
      timeout: 2000,
      env: { ...process.env, TZ: "UTC", LC_ALL: "C" },
    });
  } catch (e: any) {
    raw = typeof e?.stdout === "string" ? e.stdout : "";
  }
  const now = Date.now();
  for (const pid of pids) startCache.set(pid, { at: now });
  for (const line of raw.split("\n")) {
    const m = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (m) startCache.set(Number(m[1]), { start: normStart(m[2]), at: now });
  }
}

/** Linux: field 22 of /proc/<pid>/stat. `comm` (field 2) may hold spaces or
 *  parentheses, so count fields from after its closing paren. */
function linuxStart(pid: number): string | undefined {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
}

function actualStart(pid: number): string | undefined {
  if (process.platform === "darwin") return startCache.get(pid)?.start;
  if (process.platform === "linux") return linuxStart(pid);
  return undefined; // no reliable source elsewhere: the pid check stands
}

/**
 * Demote entries whose live pid now belongs to a different process. Only a
 * definite mismatch demotes; when the start time can't be read the pid check
 * stands.
 */
function verifyStarts(entries: LiveSession[]): void {
  const check = entries.filter((e) => e.alive === true && e.procStart);
  if (check.length === 0) return;
  const now = Date.now();
  if (process.platform === "darwin") {
    const stale = check.map((e) => e.pid).filter((pid) => {
      const c = startCache.get(pid);
      return !c || now - c.at > START_CACHE_MS;
    });
    if (stale.length > 0) darwinStarts(stale);
  }
  for (const e of check) {
    const actual = actualStart(e.pid);
    if (actual !== undefined && actual !== normStart(e.procStart!)) e.alive = false;
  }
  for (const [pid, c] of startCache) if (now - c.at > START_CACHE_MS * 5) startCache.delete(pid);
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function parseEntry(o: any): LiveSession | undefined {
  if (!o || typeof o !== "object" || typeof o.sessionId !== "string" || typeof o.pid !== "number") {
    return undefined;
  }
  const status = o.status === "busy" || o.status === "idle" || o.status === "waiting" ? o.status : undefined;
  const domain = typeof o.pidDomain === "string" ? o.pidDomain : process.platform;
  return {
    sessionId: o.sessionId,
    pid: o.pid,
    status,
    waitingFor: typeof o.waitingFor === "string" && o.waitingFor.trim() ? o.waitingFor.trim() : undefined,
    name: typeof o.name === "string" && o.name ? o.name : undefined,
    nameSource: typeof o.nameSource === "string" ? o.nameSource : undefined,
    kind: typeof o.kind === "string" ? o.kind : undefined,
    entrypoint: typeof o.entrypoint === "string" ? o.entrypoint : undefined,
    updatedAt: num(o.updatedAt),
    statusUpdatedAt: num(o.statusUpdatedAt) || num(o.updatedAt),
    procStart: typeof o.procStart === "string" && o.procStart.trim() ? o.procStart : undefined,
    alive: domain === localPidDomain() ? pidAlive(o.pid) : undefined,
  };
}

/** True when the entry describes a process that is (very likely) still running. */
export function isLive(s: LiveSession, now = Date.now()): boolean {
  return s.alive === true || (s.alive === undefined && now - s.updatedAt < UNVERIFIED_FRESH_MS);
}

/**
 * Every registry entry, keyed by session id. When several processes claim one
 * session (a resume, a stale leftover), a live one beats a dead one and the
 * most recently updated wins among equals. Empty when the directory is absent
 * (older CLIs) — callers fall back to hooks and transcripts.
 */
export function readSessionRegistry(): Map<string, LiveSession> {
  const dir = path.join(claudeHome(), "sessions");
  const out = new Map<string, LiveSession>();
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => ENTRY_FILE.test(f));
  } catch {
    return out;
  }
  const now = Date.now();
  const entries: LiveSession[] = [];
  for (const f of files) {
    try {
      const entry = parseEntry(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
      if (entry) entries.push(entry);
    } catch {
      continue; // mid-rewrite or malformed — next refresh will see it
    }
  }
  verifyStarts(entries);
  for (const entry of entries) {
    const prev = out.get(entry.sessionId);
    if (!prev) {
      out.set(entry.sessionId, entry);
      continue;
    }
    const a = isLive(entry, now);
    const b = isLive(prev, now);
    if ((a && !b) || (a === b && entry.updatedAt > prev.updatedAt)) out.set(entry.sessionId, entry);
  }
  return out;
}

/** Directory to watch for registry changes. */
export function sessionRegistryDir(): string {
  return path.join(claudeHome(), "sessions");
}
