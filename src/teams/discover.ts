import * as fs from "fs";
import * as path from "path";
import { AgentStore } from "../store";
import { AgentSession } from "../types";
import { claudeHome } from "../paths";
import {
  TeamMember,
  TeamMessage,
  TeamTask,
  TeamTaskStatus,
  TeamWorkflowRun,
  Team,
  TeamSnapshot,
} from "../board/types";

interface TeammateMeta {
  agentId: string;
  name: string;
  spawnMode?: string;
  agentType?: string;
  description?: string;
}

/** The directory holding a session's subagents/ + workflows/. */
function sidecarSubagentsDir(s: AgentSession): string {
  return path.join(path.dirname(s.jsonlPath), s.sessionId, "subagents");
}

/**
 * Named teammates of a session: the TOP-LEVEL `subagents/agent-*.meta.json`
 * sidecars that carry a `name` (Agent Teams marks teammates with a name +
 * spawnMode; plain Task subagents have neither). We do NOT recurse into
 * `subagents/workflows/` — those are workflow fan-out agents, not teammates.
 */
function readTeammates(subDir: string): TeammateMeta[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(subDir);
  } catch {
    return [];
  }
  const out: TeammateMeta[] = [];
  for (const e of entries) {
    if (!e.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, e), "utf8"));
      if (!meta || typeof meta.name !== "string" || !meta.name) continue;
      const m = /^agent-([^.]+)\.meta\.json$/.exec(e);
      out.push({
        agentId: m ? m[1] : e,
        name: meta.name,
        spawnMode: typeof meta.spawnMode === "string" ? meta.spawnMode : undefined,
        agentType: meta.agentType || meta.type,
        description: meta.description,
      });
    } catch {
      /* skip a malformed sidecar */
    }
  }
  return out;
}

const MAX_TRANSCRIPT_BYTES = 8 * 1024 * 1024;

interface LeadScan {
  /** The most recent TodoWrite `todos` array (the shared-task-list fallback). */
  todos?: any[];
  /** SendMessage calls the lead issued, oldest first. */
  sends: TeamMessage[];
}

/** One pass over the lead's transcript (tail-bounded): TodoWrite fallback list
 *  plus every SendMessage the lead issued — its half of the message mesh. */
function scanLeadTranscript(jsonlPath: string): LeadScan {
  const sends: TeamMessage[] = [];
  let raw: string;
  try {
    const stat = fs.statSync(jsonlPath);
    if (stat.size > MAX_TRANSCRIPT_BYTES) {
      const fd = fs.openSync(jsonlPath, "r");
      try {
        const buf = Buffer.alloc(MAX_TRANSCRIPT_BYTES);
        const n = fs.readSync(fd, buf, 0, MAX_TRANSCRIPT_BYTES, stat.size - MAX_TRANSCRIPT_BYTES);
        raw = buf.toString("utf8", 0, n);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      raw = fs.readFileSync(jsonlPath, "utf8");
    }
  } catch {
    return { sends };
  }
  let todos: any[] | undefined;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let o: any;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o?.isSidechain === true) continue; // the lead's own chain, not a teammate's
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b?.type !== "tool_use") continue;
      if (b.name === "TodoWrite" && Array.isArray(b.input?.todos)) {
        todos = b.input.todos;
      } else if (b.name === "SendMessage") {
        // Observed inputs duplicate both alias pairs (to/recipient,
        // message/content) — read either.
        const input = b.input || {};
        const to = [input.to, input.recipient].find(
          (s: unknown): s is string => typeof s === "string" && s.length > 0,
        );
        const text = [input.message, input.content, input.summary].find(
          (s: unknown): s is string => typeof s === "string" && s.length > 0,
        );
        const at = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN;
        sends.push({
          from: "team-lead",
          to,
          text: (text || "(message)").slice(0, 200),
          ts: Number.isNaN(at) ? 0 : at,
          kind: "chat",
        });
      }
    }
  }
  return { todos, sends };
}

/** Parse the TodoWrite list into tasks, extracting owner + dependency edges from
 *  the conventional "owner: X" / "DEPENDS ON N" hints the lead writes. */
function parseTasks(todos: any[]): TeamTask[] {
  return todos.map((t, i): TeamTask => {
    const raw = String((t && (t.content ?? t.activeForm)) ?? "").trim();
    const status: TeamTaskStatus =
      t?.status === "in_progress" ? "in_progress" : t?.status === "completed" ? "completed" : "pending";
    const ownerMatch = raw.match(/owner:\s*([^\s,(){}]+)/i);
    const dependsOn = new Set<string>();
    // "DEPENDS ON" is a deliberate uppercase sentinel, so lowercase prose
    // ("depends on 3 libraries") never registers. Only the leading number list
    // right after it counts — bounded so trailing-prose digits aren't harvested.
    const depMatch = raw.match(/DEPENDS ON\b([^.;)\n]*)/);
    if (depMatch) {
      const list = depMatch[1].match(/^[\s:]*(?:tasks?\s*)?((?:#?\d+(?:\s*(?:,|and|&)\s*)?)+)/i);
      for (const n of (list ? list[1].match(/\d+/g) : null) || []) {
        const idx = parseInt(n, 10);
        if (idx >= 1 && idx <= todos.length && idx !== i + 1) dependsOn.add(`t${idx}`);
      }
    }
    // Drop the parsed hint clusters from the display label (owner shows as a
    // badge, dependencies as edges); bounded so real wording is never swallowed.
    const content =
      raw
        .replace(/[\s—-]*[([]?\s*owner:\s*[^\s,(){}\]]+\s*[)\]]?/gi, "")
        .replace(/[\s—-]*[([]?\s*DEPENDS ON\b\s*(?:tasks?\s*)?(?:#?\d+(?:\s*(?:,|and|&)\s*)?)*[)\]]?/g, "")
        .replace(/\s{2,}/g, " ")
        .trim() || raw;
    return {
      id: `t${i + 1}`,
      content,
      status,
      owner: ownerMatch ? ownerMatch[1] : undefined,
      dependsOn: [...dependsOn],
    };
  });
}

function readWorkflowRuns(subDir: string): TeamWorkflowRun[] {
  const wfDir = path.join(subDir, "workflows");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(wfDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const runs: TeamWorkflowRun[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("wf_")) continue;
    let count = 0;
    try {
      count = fs.readdirSync(path.join(wfDir, e.name)).filter((f) => /^agent-.*\.jsonl$/.test(f)).length;
    } catch {
      /* ignore */
    }
    runs.push({ id: e.name, agentCount: count });
  }
  return runs;
}

// ---- Native Agent Teams store (~/.claude/teams + ~/.claude/tasks) ----
//
// Ground truth captured 2026-08-10 from a real team run on Claude Code 2.1.196
// (CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1):
//   teams/<team>/inboxes/<agent>.json — JSON array of
//     { from, text, timestamp, msgV, msg_id, type, read }
//   where `text` may itself be JSON for protocol traffic (shutdown_request, …).
//   config.json (documented: members[] of {name, agent_id, agent_type}) and
//   tasks/<team>/*.json (documented) were NOT observed on that version — both
//   readers below stay defensive: the store is experimental and shifts often.
// Everything here is READ-ONLY: Claude Code owns these files and rewrites them.

/** ~/.claude/teams or ~/.claude/tasks present (native Agent Teams store). */
function nativeStoreDetected(): boolean {
  return (
    fs.existsSync(path.join(claudeHome(), "teams")) || fs.existsSync(path.join(claudeHome(), "tasks"))
  );
}

function readJsonFile(p: string): any | undefined {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
}

interface NativeTeamData {
  teamName: string;
  /** Roster from config.json, when the version writes one. */
  members?: { name: string; agentId?: string; agentType?: string }[];
  /** Shared task list from ~/.claude/tasks/<team>/, when present. */
  tasks?: TeamTask[];
  /** mtime of the tasks dir (freshness gate for orphan teams). */
  tasksMtime?: number;
  /** Agent names that have a mailbox file. */
  mailboxAgents: string[];
  /** Accumulated message timeline, oldest first. */
  messages: TeamMessage[];
}

/** Parse one mailbox entry; protocol traffic (JSON in `text`) is labeled. */
function parseMailboxEntry(agent: string, e: any): { key: string; msg: TeamMessage } | undefined {
  if (!e || typeof e !== "object" || typeof e.text !== "string") return undefined;
  const at = typeof e.timestamp === "string" ? Date.parse(e.timestamp) : NaN;
  let text: string = e.text;
  let kind: TeamMessage["kind"] = "chat";
  if (text.startsWith("{")) {
    try {
      const o = JSON.parse(text);
      if (o && typeof o === "object" && typeof o.type === "string") {
        kind = "protocol";
        text = o.type.replace(/_/g, " ");
      }
    } catch {
      /* not JSON — plain chat that happens to start with a brace */
    }
  }
  const from = typeof e.from === "string" && e.from ? e.from : "unknown";
  const key =
    typeof e.msg_id === "string" && e.msg_id
      ? e.msg_id
      : `${from}|${agent}|${e.timestamp}|${text.slice(0, 40)}`;
  return {
    key,
    msg: {
      from,
      to: agent,
      text: text.slice(0, 200),
      ts: Number.isNaN(at) ? 0 : at,
      kind,
      read: e.read === true,
    },
  };
}

/**
 * Mailboxes are pruned as messages are consumed, and the whole team dir can be
 * removed on lead exit — so every message ever observed is accumulated here,
 * per team, keyed by msg_id. The cockpit timeline survives consumption; it does
 * not survive an extension-host restart (deliberate: MAS never writes state
 * into ~/.claude, and mirroring it elsewhere isn't worth the complexity yet).
 */
const seenMessages = new Map<string, Map<string, TeamMessage>>();
const MAX_TEAM_MESSAGES = 200;

function accumulateMessages(
  teamName: string,
  fresh: { key: string; msg: TeamMessage }[],
): TeamMessage[] {
  let bucket = seenMessages.get(teamName);
  if (!bucket) {
    bucket = new Map();
    seenMessages.set(teamName, bucket);
  }
  for (const { key, msg } of fresh) {
    const prev = bucket.get(key);
    if (!prev) bucket.set(key, msg);
    else if (msg.read && !prev.read) prev.read = true;
  }
  if (bucket.size > MAX_TEAM_MESSAGES) {
    const trimmed = [...bucket.entries()].sort((a, b) => a[1].ts - b[1].ts).slice(-MAX_TEAM_MESSAGES);
    bucket = new Map(trimmed);
    seenMessages.set(teamName, bucket);
  }
  return [...bucket.values()].sort((a, b) => a.ts - b.ts);
}

/** Tasks from ~/.claude/tasks/<team>/*.json, tolerant of key-name drift. */
function readNativeTasks(teamName: string): { tasks: TeamTask[]; mtime: number } | undefined {
  const dir = path.join(claudeHome(), "tasks", teamName);
  let files: string[];
  let mtime = 0;
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    mtime = fs.statSync(dir).mtimeMs;
  } catch {
    return undefined;
  }
  const tasks: TeamTask[] = [];
  for (const f of files) {
    const o = readJsonFile(path.join(dir, f));
    if (!o || typeof o !== "object") continue;
    const content = [o.task_name, o.name, o.subject, o.description, o.content].find(
      (s: unknown): s is string => typeof s === "string" && s.length > 0,
    );
    if (!content) continue;
    const rawStatus = String(o.status ?? o.task_status ?? "pending");
    const status: TeamTaskStatus = /progress|active/i.test(rawStatus)
      ? "in_progress"
      : /complete|done/i.test(rawStatus)
        ? "completed"
        : "pending";
    const deps = [o.depends_on, o.dependsOn, o.blocked_by].find(Array.isArray) || [];
    tasks.push({
      id: String(o.id ?? o.task_id ?? f.replace(/\.json$/, "")),
      content: content.replace(/\s+/g, " ").trim().slice(0, 200),
      status,
      owner: [o.assigned_to, o.owner, o.assignee].find(
        (s: unknown): s is string => typeof s === "string" && s.length > 0,
      ),
      dependsOn: deps.map(String),
    });
  }
  if (tasks.length === 0) return undefined;
  tasks.sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  return { tasks, mtime };
}

/** Read every team in the native store (roster, tasks, mailbox timeline). */
function readNativeStore(): NativeTeamData[] {
  const teamsDir = path.join(claudeHome(), "teams");
  let dirs: fs.Dirent[];
  try {
    dirs = fs.readdirSync(teamsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: NativeTeamData[] = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const base = path.join(teamsDir, d.name);
    const cfg = readJsonFile(path.join(base, "config.json"));
    let members: NativeTeamData["members"];
    if (Array.isArray(cfg?.members)) {
      members = cfg.members
        .filter((m: any) => m && typeof m.name === "string" && m.name)
        .map((m: any) => ({
          name: m.name,
          agentId: typeof m.agent_id === "string" ? m.agent_id : undefined,
          agentType: typeof m.agent_type === "string" ? m.agent_type : undefined,
        }));
    }
    const mailboxAgents: string[] = [];
    const fresh: { key: string; msg: TeamMessage }[] = [];
    let inboxFiles: string[] = [];
    try {
      inboxFiles = fs.readdirSync(path.join(base, "inboxes"));
    } catch {
      /* no inboxes yet */
    }
    for (const f of inboxFiles) {
      if (!f.endsWith(".json")) continue;
      const agent = f.slice(0, -5);
      mailboxAgents.push(agent);
      const arr = readJsonFile(path.join(base, "inboxes", f));
      if (!Array.isArray(arr)) continue;
      for (const e of arr) {
        const parsed = parseMailboxEntry(agent, e);
        if (parsed) fresh.push(parsed);
      }
    }
    const nativeTasks = readNativeTasks(d.name);
    out.push({
      teamName: d.name,
      members,
      tasks: nativeTasks?.tasks,
      tasksMtime: nativeTasks?.mtime,
      mailboxAgents,
      messages: accumulateMessages(d.name, fresh),
    });
  }
  return out;
}

/** All teammate names a native team knows about (config roster + mailboxes). */
function nativeTeamNames(n: NativeTeamData): string[] {
  const names = new Set<string>(n.mailboxAgents);
  for (const m of n.members || []) names.add(m.name);
  names.delete("team-lead");
  return [...names];
}

/** Merge the lead's transcript sends into the mailbox timeline, skipping sends
 *  the mailbox already recorded (same route + text — timestamps differ). */
function mergeMessages(mailbox: TeamMessage[], sends: TeamMessage[]): TeamMessage[] {
  const known = new Set(mailbox.map((m) => `${m.from}|${m.to}|${m.text.slice(0, 60)}`));
  const merged = [...mailbox];
  for (const s of sends) {
    if (!known.has(`${s.from}|${s.to}|${s.text.slice(0, 60)}`)) merged.push(s);
  }
  return merged.sort((a, b) => a.ts - b.ts).slice(-MAX_TEAM_MESSAGES);
}

/** Orphan native teams (no live session matched) only surface while fresh —
 *  leftover mailbox files would otherwise haunt the cockpit forever. */
const ORPHAN_TEAM_WINDOW_MS = 24 * 60 * 60_000;

function tokensOf(a: AgentSession | undefined): number {
  if (!a) return 0;
  const t = a.tokens;
  return t.input + t.output + t.cacheRead + t.cacheCreate;
}

/** Bound on the number of teams built per snapshot (each reads a transcript). */
const MAX_TEAMS = 8;

/** Roster of named teammates, enriched with the store's live status/tokens. */
function buildMembers(s: AgentSession, roster: TeammateMeta[]): TeamMember[] {
  const subs = s.subagents || [];
  return roster
    .map((meta): TeamMember => {
      const live = subs.find((x) => x.sessionId === meta.agentId);
      return {
        sessionId: meta.agentId,
        name: meta.name,
        agentType: meta.agentType,
        spawnMode: meta.spawnMode,
        status: live?.status || "unknown",
        tokensTotal: tokensOf(live),
        lastAction: live?.liveAction || live?.lastAction,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Build a live snapshot of EVERY active team, most-recently-active first.
 * Each session with named teammates becomes a Team; when the native Agent
 * Teams store has a matching team (roster-name overlap), its task list wins
 * over the TodoWrite fallback and its mailbox timeline is attached. Native
 * teams with no matching live session still surface (store-only) while fresh.
 * Capped at MAX_TEAMS transcript reads.
 */
export function buildTeamSnapshot(store: AgentStore): TeamSnapshot {
  const nativeTeams = readNativeStore();
  const sessions = store
    .list()
    .filter((a) => a.kind === "session")
    .sort((a, b) => b.lastActivity - a.lastActivity);

  const teams: Team[] = [];
  const claimed = new Set<string>();
  let usedNative = false;

  for (const s of sessions) {
    if (teams.length >= MAX_TEAMS) break;
    const roster = readTeammates(sidecarSubagentsDir(s));
    if (roster.length === 0) continue;
    const scan = scanLeadTranscript(s.jsonlPath);
    const match = nativeTeams.find(
      (n) =>
        !claimed.has(n.teamName) && nativeTeamNames(n).some((name) => roster.some((r) => r.name === name)),
    );
    if (match) claimed.add(match.teamName);
    if (match?.tasks?.length || match?.members?.length) usedNative = true;
    teams.push({
      leadSessionId: s.sessionId,
      leadLabel: s.label,
      teamName: match?.teamName,
      members: buildMembers(s, roster),
      tasks: match?.tasks?.length ? match.tasks : scan.todos ? parseTasks(scan.todos) : [],
      workflowRuns: readWorkflowRuns(sidecarSubagentsDir(s)),
      messages: mergeMessages(match?.messages ?? [], scan.sends),
    });
  }

  // Store-only teams: native data whose lead session isn't discoverable
  // (deleted transcript, other machine's home, cross-session team). Fresh only.
  for (const n of nativeTeams) {
    if (teams.length >= MAX_TEAMS) break;
    if (claimed.has(n.teamName)) continue;
    const newest = Math.max(n.tasksMtime || 0, ...n.messages.map((m) => m.ts));
    if (!newest || Date.now() - newest > ORPHAN_TEAM_WINDOW_MS) continue;
    const roster: TeamMember[] = (
      n.members ?? nativeTeamNames(n).map((name) => ({ name, agentId: undefined, agentType: undefined }))
    )
      .filter((m) => m.name !== "team-lead")
      .map((m) => ({
        sessionId: m.agentId || m.name,
        name: m.name,
        agentType: m.agentType,
        status: "unknown" as const,
        tokensTotal: 0,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
    if (roster.length === 0 && n.messages.length === 0 && !n.tasks?.length) continue;
    usedNative = true;
    teams.push({
      leadSessionId: `native:${n.teamName}`,
      leadLabel: `Team ${n.teamName}`,
      teamName: n.teamName,
      members: roster,
      tasks: n.tasks ?? [],
      workflowRuns: [],
      messages: n.messages,
    });
  }

  return {
    present: teams.length > 0,
    source: teams.length === 0 ? "none" : usedNative ? "native" : "todowrite",
    teams,
    nativeStoreDetected: nativeTeams.length > 0 || nativeStoreDetected(),
  };
}
