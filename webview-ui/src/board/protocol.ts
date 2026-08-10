// Mirror of src/board/types.ts + src/board/materialize.ts data shapes
// (kept in sync manually — separate tsconfig roots).
import type { AgentSummary, AgentStatus } from "../protocol";

export type { AgentSummary };

// ---- Teams cockpit ----

export type TeamTaskStatus = "pending" | "in_progress" | "completed";

export interface TeamMember {
  sessionId: string;
  name: string;
  agentType?: string;
  /** "plan" => spawned read-only awaiting the lead's plan approval. */
  spawnMode?: string;
  status: AgentStatus;
  tokensTotal: number;
  lastAction?: string;
}

export interface TeamTask {
  id: string;
  content: string;
  status: TeamTaskStatus;
  owner?: string;
  dependsOn: string[];
}

export interface TeamWorkflowRun {
  id: string;
  agentCount: number;
}

/** One observed inter-agent message — a native-mailbox delivery or a
 *  SendMessage the lead's transcript recorded. */
export interface TeamMessage {
  from: string;
  to?: string;
  text: string;
  ts: number;
  /** "protocol" = structured team plumbing (shutdown requests, approvals). */
  kind: "chat" | "protocol";
  read?: boolean;
}

export interface Team {
  leadSessionId: string;
  leadLabel: string;
  /** Native store directory name (~/.claude/teams/<teamName>), when matched. */
  teamName?: string;
  members: TeamMember[];
  tasks: TeamTask[];
  workflowRuns: TeamWorkflowRun[];
  /** Message-mesh timeline, oldest first (accumulated across mailbox prunes). */
  messages: TeamMessage[];
}

export interface TeamSnapshot {
  present: boolean;
  source: "native" | "todowrite" | "none";
  /** All active teams, most-recently-active first. */
  teams: Team[];
  nativeStoreDetected: boolean;
}

// ---- Session Board data (mirror of src/board/materialize.ts) ----

export interface EventStrip {
  seq: string;
  ts: number[];
  total: number;
}

export interface BoardCommit {
  hash: string;
  subject: string;
  ts: number;
}

export interface BoardPlanItem {
  content: string;
  status: "completed" | "in_progress" | "pending";
}

export interface BoardNote {
  text: string;
  ts: number;
}

/** One inter-agent message: a SendMessage the session issued ("out") or a
 *  coordinator/teammate/task message delivered into its transcript ("in"). */
export interface BoardMessage {
  dir: "out" | "in";
  /** The other end — recipient for "out", sender for "in" (when known). */
  peer?: string;
  text: string;
  ts: number;
}

export interface BoardMachinery {
  edits: number;
  shell: number;
  reads: number;
  other: number;
  errors: string[];
  selfHealed: number;
  stallMin?: number;
}

export interface BoardEpisode {
  index: number;
  startTs: number;
  endTs: number;
  prompt: string;
  promptTs: number;
  requirements: string[];
  notes: BoardNote[];
  notesDropped: number;
  plan?: { items: BoardPlanItem[]; snapshots: number };
  evidence: string[];
  /** Inter-agent traffic (Agent Teams / cross-session messaging). */
  messages: BoardMessage[];
  messagesDropped: number;
  machinery: BoardMachinery;
  commits: BoardCommit[];
}

export interface SessionBoardData {
  sessionId: string;
  label: string;
  gitBranch?: string;
  startTs: number;
  endTs: number;
  episodes: BoardEpisode[];
  shelf: { file: string; edits: number }[];
  shelfDropped: number;
  strip: EventStrip | null;
  totals: {
    events: number;
    toolCalls: number;
    edits: number;
    prompts: number;
    words: number;
    commits: number;
    /** Inter-agent messages (both directions). */
    messages: number;
  };
}

/** One board object the user selected to hand to an agent. */
export interface BoardObjectRef {
  kind: "exchange" | "requirement" | "note" | "plan" | "evidence" | "commit" | "machinery" | "message";
  title: string;
  detail?: string;
  ts?: number;
  episode?: number;
}

// ---- webview protocol ----

export type ExtToBoard =
  | { type: "fleet"; agents: AgentSummary[] }
  | { type: "sessionBoard"; board: SessionBoardData | null }
  | { type: "meta"; showOlder: boolean; hiddenCount: number }
  | { type: "config"; boardDir: string; hooksReady: boolean }
  | { type: "teams"; snapshot: TeamSnapshot };

export type BoardToExt =
  | { type: "ready" }
  | { type: "selectSession"; sessionId: string | null }
  | { type: "sendToAgent"; sessionId: string; objects: BoardObjectRef[] }
  | { type: "focusAgent"; sessionId: string }
  | { type: "openDiff"; sessionId: string }
  | { type: "toggleOlder" }
  | { type: "newAgent" };
