// Question Intake (spec S5.1) — turns the two real sources of "an agent is
// blocked on the human" into Questions the engine can compress.
//
//   A. explicit asks   AskUserQuestion tool calls and permission Notifications,
//                      read from hooks when they're installed and from the
//                      session transcript otherwise (zero-config fallback).
//   B. implicit ones   two live sessions editing the same file — synthesized
//                      as a `conflict` Question that never dedups or
//                      auto-answers.
//
// Intake deliberately reuses the channels Agent View already owns (the hook
// server and the transcript parser); it never opens a second one.

import { createHash } from "crypto";
import * as path from "path";
import { AgentSession } from "../types";
import { readParsedLines } from "../transcript";
import { Conflict } from "../webview/protocol";
import { Question, QuestionContext, QuestionKind } from "./types";
import { ticketFromBranch } from "./text";

/** The raw ask, before normalization. */
export interface RawQuestion {
  kind: QuestionKind;
  /** What the human reads: the question plus its rendered options. */
  text: string;
  /** What Normalize runs on — the question alone. Option *descriptions* are
   *  prose that varies between sessions asking the identical question, so
   *  matching on them would split clusters that should merge. */
  intentText?: string;
  options?: string[];
  /** The AskUserQuestion tool_use this came from. Lets Triage read back the
   *  answer if the human replies at the session instead of in the inbox. */
  toolUseId?: string;
  /** Stable per distinct ask, so a heartbeat doesn't re-intake the same one. */
  key: string;
}

const MAX_TEXT = 1200;

function key(sessionId: string, text: string): string {
  return `${sessionId}:${createHash("sha1").update(text).digest("hex").slice(0, 12)}`;
}

/** Flatten an AskUserQuestion tool input into readable text + option labels. */
export function describeAsk(
  input: any,
): { text: string; question: string; options: string[] } | null {
  const questions = Array.isArray(input?.questions) ? input.questions : [];
  if (questions.length === 0) return null;
  const options: string[] = [];
  const asked: string[] = [];
  const text = questions
    .map((q: any) => {
      const opts = Array.isArray(q?.options) ? q.options : [];
      for (const o of opts) if (typeof o?.label === "string") options.push(o.label);
      if (typeof q?.question === "string" && q.question) asked.push(q.question);
      const rendered = opts
        .map((o: any) => `- ${o?.label ?? ""}${o?.description ? ` — ${o.description}` : ""}`)
        .join("\n");
      return `${q?.question ?? ""}${rendered ? `\n${rendered}` : ""}`;
    })
    .join("\n\n")
    .trim();
  if (!text) return null;
  return {
    text: text.slice(0, MAX_TEXT),
    question: (asked.join(" ") || text).slice(0, MAX_TEXT),
    options: [...new Set(options)].slice(0, 8),
  };
}

/**
 * The ask a session is currently blocked on, read from its transcript. Used
 * when hooks aren't installed, and as the source of the raw text for holds.
 * Returns null when the session isn't blocked on anything answerable.
 */
export function pendingQuestion(session: AgentSession): RawQuestion | null {
  const lines = readParsedLines(session.jsonlPath);
  if (lines.length === 0) return null;

  const answered = new Set<string>();
  let lastAsk: { id?: string; input: any } | undefined;
  let lastAssistantText = "";

  for (const line of lines) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) {
      if (line?.type === "assistant" && typeof content === "string") lastAssistantText = content;
      continue;
    }
    for (const b of content) {
      if (b?.type === "tool_result" && typeof b.tool_use_id === "string") answered.add(b.tool_use_id);
      else if (b?.type === "tool_use" && b.name === "AskUserQuestion") lastAsk = { id: b.id, input: b.input };
      else if (b?.type === "text" && line?.type === "assistant" && typeof b.text === "string") {
        lastAssistantText = b.text;
      }
    }
  }

  if (lastAsk && (!lastAsk.id || !answered.has(lastAsk.id))) {
    const described = describeAsk(lastAsk.input);
    if (described) {
      return {
        kind: "ask",
        text: described.text,
        intentText: described.question,
        options: described.options,
        toolUseId: lastAsk.id,
        key: key(session.sessionId, described.text),
      };
    }
  }

  // No structured ask, but the session is parked: a trailing question in the
  // assistant's own words is the next best thing, and a permission prompt shows
  // up only as "waiting" with the tool it wants in lastAction.
  if (session.status !== "waiting") return null;
  const trailing = lastAssistantText.trim();
  if (trailing.endsWith("?")) {
    const text = trailing.slice(-MAX_TEXT);
    return { kind: "ask", text, key: key(session.sessionId, text) };
  }
  const action = session.liveAction || session.lastAction;
  if (!action) return null;
  const text = `Permission requested: ${action}`;
  return { kind: "permission", text, key: key(session.sessionId, text) };
}

/** A permission Notification hook event, as a Question. Null when it isn't one. */
export function questionFromNotification(event: any): RawQuestion | null {
  const name = event?.hook_event_name || event?.hookEventName;
  if (name !== "Notification") return null;
  const type: string = event?.notification_type || "";
  if (type && !type.includes("permission")) return null; // idle pings aren't asks
  const message = String(event?.message || "").trim();
  if (!message) return null;
  const sessionId = event?.session_id || event?.sessionId || "";
  const text = message.slice(0, MAX_TEXT);
  return { kind: "permission", text, key: key(sessionId, text) };
}

/** A held PreToolUse/AskUserQuestion hook event, as a Question. */
export function questionFromAskHook(event: any): RawQuestion | null {
  const name = event?.hook_event_name || event?.hookEventName;
  const tool = event?.tool_name || event?.toolName;
  if (name !== "PreToolUse" || tool !== "AskUserQuestion") return null;
  const described = describeAsk(event?.tool_input || event?.toolInput);
  if (!described) return null;
  const sessionId = event?.session_id || event?.sessionId || "";
  return {
    kind: "ask",
    text: described.text,
    intentText: described.question,
    options: described.options,
    toolUseId: event?.tool_use_id || event?.toolUseId,
    key: key(sessionId, described.text),
  };
}

/**
 * The answer an AskUserQuestion eventually received, read back off the
 * transcript — i.e. the human walked over to the session and answered there
 * instead of in the Triage inbox. Without this, every such answer is invisible
 * to the Decision Log and the next session asks the same thing again.
 *
 * Claude Code records it two ways; the structured map is authoritative and the
 * result sentence is the fallback:
 *   toolUseResult.answers  {"<question>": "<chosen label>"}
 *   content                'Your questions have been answered: "<q>"="<a>". ...'
 */
export function answerAtSession(session: AgentSession, toolUseId: string): string | null {
  for (const line of readParsedLines(session.jsonlPath)) {
    const content = line?.message?.content;
    if (!Array.isArray(content)) continue;
    if (!content.some((b: any) => b?.type === "tool_result" && b.tool_use_id === toolUseId)) continue;

    const answers = line?.toolUseResult?.answers;
    if (answers && typeof answers === "object") {
      const picked = Object.values(answers)
        .filter((v): v is string => typeof v === "string" && !!v.trim())
        .map((v) => v.trim());
      if (picked.length) return picked.join("; ").slice(0, MAX_TEXT);
    }

    const block = content.find((b: any) => b?.type === "tool_result" && b.tool_use_id === toolUseId);
    const raw = typeof block?.content === "string" ? block.content : "";
    const pairs = [...raw.matchAll(/"[^"]*"="([^"]*)"/g)].map((m) => m[1]).filter(Boolean);
    if (pairs.length) return pairs.join("; ").slice(0, MAX_TEXT);
    return null;
  }
  return null;
}

export function contextFor(session: AgentSession, repoRoot?: string): QuestionContext {
  return {
    repo: repoRoot || session.worktreePath || session.cwd,
    branch: session.gitBranch || "",
    cwd: session.cwd,
    files: (session.filesTouched || []).slice(0, 12),
    ticket: ticketFromBranch(session.gitBranch),
  };
}

/**
 * Source B — a synthetic Question per file two live sessions are both editing.
 * These never dedup and never auto-answer; they exist so a collision surfaces
 * now rather than at merge time.
 */
export function conflictQuestions(
  conflicts: Conflict[],
  sessions: Map<string, AgentSession>,
  repoOf: (s: AgentSession) => string,
): { raw: RawQuestion; session: AgentSession; others: string[] }[] {
  const out: { raw: RawQuestion; session: AgentSession; others: string[] }[] = [];
  for (const c of conflicts) {
    const owner = sessions.get(c.agents[0]?.sessionId);
    if (!owner) continue;
    const others = c.agents.slice(1).map((a) => a.label);
    const text =
      `${c.agents.length} sessions are editing ${path.basename(c.file)} at the same time ` +
      `(${c.agents.map((a) => a.label).join(", ")}). Decide who owns it before they diverge.`;
    out.push({
      raw: { kind: "conflict", text, key: `conflict:${repoOf(owner)}:${c.file}` },
      session: owner,
      others,
    });
  }
  return out;
}

/** Build the final Question record. Ids are content-derived so a re-ask of the
 *  identical question maps back to the same hold. */
export function toQuestion(raw: RawQuestion, session: AgentSession, context: QuestionContext): Question {
  return {
    id: raw.key,
    sessionId: session.sessionId,
    kind: raw.kind,
    text: raw.text,
    intentText: raw.intentText,
    options: raw.options,
    toolUseId: raw.toolUseId,
    context,
    createdAt: Date.now(),
  };
}
