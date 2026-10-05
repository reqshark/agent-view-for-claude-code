import * as fs from "fs";
import { addBilled, BilledUsage, billedFromApi, emptyBilled } from "./pricing";
import { PlanItem, PlanTracker } from "./util/planTracker";

/**
 * Whole-transcript totals — billed usage and the agent's plan — read
 * incrementally.
 *
 * Both need the WHOLE file (parseTranscript only reads the tail of big ones):
 * cost accumulates, and the Task tools build a plan one call at a time. So
 * each path keeps a byte offset and only newly appended lines are parsed on
 * later refreshes. Claude Code writes one assistant message as several lines
 * (one per content block) that all repeat the same `usage`, so a message is
 * counted once, by `message.id` — the lines for one message are contiguous, so
 * only the one in flight is held back and a short list of recent ids guards
 * against a straggler. A file that shrinks (Claude Code self-heals corrupted
 * transcripts in place) is rescanned from the start.
 */

interface Pending {
  id: string;
  model: string;
  usage: BilledUsage;
}

interface ScanState {
  offset: number;
  byModel: Map<string, BilledUsage>;
  pending?: Pending;
  recentIds: string[];
  /** Largest of Claude Code's own `cost-state` snapshots. */
  nativeCost?: number;
  plan: PlanTracker;
}

export interface UsageTotals {
  /** Billed usage per model id. */
  byModel: Record<string, BilledUsage>;
  /** Output tokens across all models (each message once). */
  outputTokens: number;
  /** Largest of Claude Code's own cost snapshots, when it wrote any. It sees
   *  calls the transcript doesn't (auto-mode classifier, compaction) but is
   *  per process and lags the latest turn — so it and the transcript-derived
   *  figure are both lower bounds. (The max, not a sum: whether a resumed
   *  process restores the total or restarts it, the max never overcounts.) */
  nativeCostUsd?: number;
  /** The agent's plan (TodoWrite or Task tools), from the whole file. */
  plan?: PlanItem[];
}

const RECENT_IDS = 64;
const CHUNK_BYTES = 4 * 1024 * 1024;
const states = new Map<string, ScanState>();

function freshState(): ScanState {
  return { offset: 0, byModel: new Map(), recentIds: [], plan: new PlanTracker() };
}

function commit(st: ScanState, p: Pending): void {
  let acc = st.byModel.get(p.model);
  if (!acc) {
    acc = emptyBilled();
    st.byModel.set(p.model, acc);
  }
  addBilled(acc, p.usage);
  st.recentIds.push(p.id);
  if (st.recentIds.length > RECENT_IDS) st.recentIds.shift();
}

/** Record-type match, so a tool input that merely mentions "cost-state" is not one. */
const COST_STATE_RE = /"type":\s*"cost-state"/;
/** Lines that can change a plan: the tool calls, and TaskCreate's result. */
const PLAN_RE = /"(?:TodoWrite|TaskCreate|TaskUpdate)"|Task #\d/;

function ingestLine(st: ScanState, line: string): void {
  const costState = COST_STATE_RE.test(line);
  const planLine = PLAN_RE.test(line);
  // Cheap prefilter: only assistant lines carry usage.
  const usageLine = line.includes('"usage"') && line.includes('"assistant"');
  if (!costState && !planLine && !usageLine) return;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (costState && o?.type === "cost-state") {
    const total = Number(o.totalCostUSD);
    if (Number.isFinite(total)) st.nativeCost = Math.max(st.nativeCost ?? 0, total);
    return;
  }
  if (planLine) st.plan.feed(o);
  if (o?.type !== "assistant") return;
  const m = o.message;
  const id = m?.id;
  if (!m?.usage || typeof id !== "string") return;
  const usage = billedFromApi(m.usage);
  const model = typeof m.model === "string" && m.model ? m.model : "unknown";
  if (st.pending?.id === id) {
    // Later block of the same message — keep the fuller usage.
    if (usage.output >= st.pending.usage.output) st.pending.usage = usage;
    return;
  }
  if (st.recentIds.includes(id)) return;
  if (st.pending) commit(st, st.pending);
  st.pending = { id, model, usage };
}

/** Totals for a transcript; undefined when it can't be read. */
export function scanUsage(jsonlPath: string): UsageTotals | undefined {
  let size: number;
  try {
    size = fs.statSync(jsonlPath).size;
  } catch {
    states.delete(jsonlPath);
    return undefined;
  }
  let st = states.get(jsonlPath);
  if (!st || size < st.offset) {
    st = freshState();
    states.set(jsonlPath, st);
  }
  if (size > st.offset) {
    let fd: number | undefined;
    try {
      fd = fs.openSync(jsonlPath, "r");
      while (st.offset < size) {
        const len = Math.min(CHUNK_BYTES, size - st.offset);
        const buf = Buffer.alloc(len);
        const read = fs.readSync(fd, buf, 0, len, st.offset);
        if (read <= 0) break;
        // Only consume complete lines; a half-written last line waits.
        const lastNl = buf.lastIndexOf(0x0a, read - 1);
        if (lastNl < 0) {
          if (read < CHUNK_BYTES) break; // partial line at EOF
          st.offset += read; // a single >4MB line — skip it
          continue;
        }
        for (const line of buf.toString("utf8", 0, lastNl).split("\n")) {
          if (line) ingestLine(st, line);
        }
        st.offset += lastNl + 1;
      }
    } catch {
      /* keep what we have; retried on the next refresh */
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }
  }

  const byModel: Record<string, BilledUsage> = {};
  let outputTokens = 0;
  for (const [model, u] of st.byModel) {
    byModel[model] = { ...u };
    outputTokens += u.output;
  }
  if (st.pending) {
    const acc = (byModel[st.pending.model] ||= emptyBilled());
    addBilled(acc, st.pending.usage);
    outputTokens += st.pending.usage.output;
  }
  return { byModel, outputTokens, nativeCostUsd: st.nativeCost, plan: st.plan.items() };
}

/** Drop cached scan state for transcripts that left discovery. */
export function pruneUsageCache(livePaths: Set<string>): void {
  for (const p of states.keys()) if (!livePaths.has(p)) states.delete(p);
}
