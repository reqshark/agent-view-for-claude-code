import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { post } from "./vscodeApi";
import { Dot, STATUS_LABEL, fmtTok, permissionModeLabel, relTime, shortAgentType } from "./ui";
import { RaceView } from "./RaceView";
import { FanoutView } from "./FanoutView";
import { ReviewView } from "./ReviewView";
import { Strip } from "./Strip";
import type {
  AgentStatus,
  AgentSummary,
  Conflict,
  ExtToWeb,
  RaceGroup,
  ReviewQueue,
  RouterItem,
  StripData,
  TranscriptMessage,
  ViewMode,
} from "./protocol";

marked.setOptions({ gfm: true, breaks: true });

function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () => DOMPurify.sanitize(marked.parse(text, { async: false }) as string),
    [text],
  );
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}

const SOURCE_TITLE: Record<NonNullable<AgentSummary["statusSource"]>, string> = {
  hook: "from Claude Code hooks",
  registry: "from Claude Code's live session state",
  jsonl: "inferred from transcript",
};

function metaLine(a: AgentSummary): string {
  const bits: string[] = [];
  if (a.model) bits.push(a.model.replace(/^claude-/, ""));
  bits.push(`${fmtTok(a.tokensTotal)} tok`);
  if (a.costUsd && a.costUsd >= 0.01) bits.push(`~$${a.costUsd.toFixed(2)}`);
  bits.push(relTime(a.lastActivity));
  return bits.join(" · ");
}

export function App() {
  const [fleet, setFleet] = useState<AgentSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [transcript, setTranscript] = useState<TranscriptMessage[]>([]);
  const [strip, setStrip] = useState<StripData | null>(null);
  const [conflicts, setConflicts] = useState<Conflict[]>([]);
  const [router, setRouter] = useState<RouterItem[]>([]);
  const [view, setView] = useState<ViewMode>("detail");
  const [race, setRace] = useState<RaceGroup | null>(null);
  const [review, setReview] = useState<ReviewQueue | null>(null);
  const [fanoutText, setFanoutText] = useState("");
  // The dialogue box's drafts, one per session, and the receipt line.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [composeNote, setComposeNote] = useState("");
  const composeText = selected ? drafts[selected] || "" : "";
  const setComposeText = (text: string) => {
    if (selected) setDrafts((d) => ({ ...d, [selected]: text }));
  };
  const scrollRef = useRef<HTMLDivElement>(null);
  const composeRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const onMsg = (e: MessageEvent<ExtToWeb>) => {
      const msg = e.data;
      if (msg.type === "fleet") setFleet(msg.agents);
      else if (msg.type === "selected") setSelected(msg.sessionId);
      else if (msg.type === "transcript") {
        setTranscript(msg.messages);
        setStrip(msg.strip);
      }
      else if (msg.type === "view") setView(msg.view);
      else if (msg.type === "race") setRace(msg.group);
      else if (msg.type === "review") setReview(msg.queue);
      else if (msg.type === "insights") {
        setConflicts(msg.conflicts);
        setRouter(msg.router);
      }
      else if (msg.type === "composed") setComposeNote(msg.note);
      else if (msg.type === "draft") {
        // An editor selection joins the session's draft; the box takes focus.
        setDrafts((d) => {
          const had = d[msg.sessionId] || "";
          return { ...d, [msg.sessionId]: (had ? had.replace(/\n*$/, "\n") : "") + msg.text + "\n" };
        });
        setTimeout(() => composeRef.current?.focus(), 0);
      }
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const sessions = useMemo(() => fleet.filter((a) => a.kind === "session"), [fleet]);
  const subsByParent = useMemo(() => {
    const m = new Map<string, AgentSummary[]>();
    for (const a of fleet) {
      if (a.kind === "subagent" && a.parentId) {
        const arr = m.get(a.parentId) ?? [];
        arr.push(a);
        m.set(a.parentId, arr);
      }
    }
    return m;
  }, [fleet]);

  const select = (id: string) => {
    setSelected(id);
    setComposeNote("");
    post({ type: "select", sessionId: id });
  };

  // The dialogue box: the text goes to the session's inbox, and the
  // workflow-pane plugin in that session submits it as the person's own
  // prompt once the session is idle; the reply shows in the transcript.
  const compose = () => {
    const text = composeText.trim();
    if (!text || !selected) return;
    post({ type: "compose", sessionId: selected, text });
    setComposeText("");
    setComposeNote("sending…");
  };

  const switchView = (v: ViewMode) => {
    setView(v);
    post({ type: "setView", view: v });
  };

  const acknowledge = (id: string) => post({ type: "acknowledge", sessionId: id });
  const acknowledgeAll = () => post({ type: "acknowledgeAll" });

  const focused = useMemo(
    () => fleet.find((a) => a.sessionId === selected) || null,
    [fleet, selected],
  );

  // Auto-focus the running agent (or most recent) when nothing is selected.
  useEffect(() => {
    if (view !== "detail" || focused || fleet.length === 0) return;
    const pick = sessions.find((s) => s.status === "running") || sessions[0];
    if (pick) select(pick.sessionId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fleet, focused, view]);

  // Auto-scroll the transcript to the newest message.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, selected]);

  // A Scroll tick maps back through its timestamp to the nearest loaded
  // message (the transcript keeps the most recent 200 — earlier ticks clamp
  // to the oldest loaded one).
  const jumpToTs = (_i: number, ts: number) => {
    if (transcript.length === 0) return;
    let idx = transcript.findIndex((m) => m.ts >= ts);
    if (idx < 0) idx = transcript.length - 1;
    scrollRef.current
      ?.querySelector(`[data-i="${idx}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const counts = useMemo(() => {
    const c: Partial<Record<AgentStatus, number>> = {};
    for (const a of sessions) c[a.status] = (c[a.status] || 0) + 1;
    return c;
  }, [sessions]);

  // Only surface subagents that are actually live — idle/done ones are noise.
  const focusedSubs =
    focused && focused.kind === "session"
      ? (subsByParent.get(focused.sessionId) || []).filter(
          (s) => s.status === "running" || s.status === "waiting" || s.status === "thinking",
        )
      : [];

  return (
    <div className="app">
      <header className="toolbar">
        <div className="counts">
          <span className="count"><Dot status="running" /> {counts.running || 0}</span>
          <span className="count"><Dot status="waiting" /> {counts.waiting || 0}</span>
          <span className="count"><Dot status="idle" /> {counts.idle || 0}</span>
        </div>
        <div className="tabs">
          <button className={"tab" + (view === "detail" ? " active" : "")} onClick={() => switchView("detail")}>
            Detail
          </button>
          {race && (
            <button className={"tab" + (view === "race" ? " active" : "")} onClick={() => switchView("race")}>
              Race
            </button>
          )}
          <button className={"tab" + (view === "fanout" ? " active" : "")} onClick={() => switchView("fanout")}>
            Fan-out
          </button>
          <button className={"tab" + (view === "review" ? " active" : "")} onClick={() => switchView("review")}>
            Review
          </button>
        </div>
      </header>

      {view === "race" && <RaceView group={race} />}
      {view === "fanout" && <FanoutView text={fanoutText} onChange={setFanoutText} />}
      {view === "review" && <ReviewView queue={review} />}

      {view === "detail" && (
        <>
          {router.filter((r) => r.urgency !== "ok").length > 0 && (
            <section className="inbox">
              <div className="inbox-head">
                <span>needs you {router.some((r) => r.source === "ai") ? "· AI" : ""}</span>
                <button
                  className="inbox-clear"
                  onClick={acknowledgeAll}
                  title="Dismiss all — they resurface on new activity"
                >
                  Dismiss all
                </button>
              </div>
              {router
                .filter((r) => r.urgency !== "ok")
                .slice(0, 6)
                .map((r) => (
                  <div
                    key={r.sessionId}
                    className={"inbox-row " + r.urgency}
                    onClick={() => select(r.sessionId)}
                    title={r.label}
                  >
                    <span className={"urgency-pip " + r.urgency} />
                    <span className="inbox-label">{r.label}</span>
                    <span className="inbox-reason">{r.action || r.reason}</span>
                    <button
                      className="inbox-dismiss"
                      onClick={(e) => {
                        e.stopPropagation();
                        acknowledge(r.sessionId);
                      }}
                      title="Dismiss — resurfaces on new activity"
                      aria-label="Dismiss"
                    >
                      ×
                    </button>
                  </div>
                ))}
            </section>
          )}

          {conflicts.length > 0 && (
            <section className="conflicts">
              <div className="conflicts-head">{conflicts.length} file conflict{conflicts.length === 1 ? "" : "s"}</div>
              {conflicts.slice(0, 5).map((c) => (
                <div key={c.file} className="conflict-row" title={c.file}>
                  <span className="conflict-file">{c.file.split("/").pop()}</span>
                  <span className="conflict-agents">{c.agents.map((a) => a.label.slice(0, 18)).join(" · ")}</span>
                </div>
              ))}
            </section>
          )}

          {!focused && <div className="empty">Select an agent in the Agents list above.</div>}

          {focused && (
            <section className="focus">
              <div className="focus-title">
                <Dot status={focused.status} />
                <span className="focus-label">{focused.label || focused.sessionId.slice(0, 8)}</span>
              </div>
              <div className="focus-meta">
                <span className={"status-pill " + focused.status}>{STATUS_LABEL[focused.status]}</span>
                {focused.status === "waiting" && focused.waitingFor && (
                  <span className="status-pill waiting reason" title={focused.waitingFor}>
                    {focused.waitingFor}
                  </span>
                )}
                {focused.plan && focused.plan.total > 0 && (
                  <span className="status-pill plan reason" title={focused.plan.current || "plan progress"}>
                    {focused.plan.done}/{focused.plan.total}
                    {focused.plan.current ? " · " + focused.plan.current : ""}
                  </span>
                )}
                {focused.lastError && (
                  <span className="status-pill error reason" title={focused.lastError}>
                    {focused.lastError}
                  </span>
                )}
                {!!focused.activeSubagents && (
                  <span className="status-pill thinking" title="Waiting on subagents — they're still working">
                    {focused.activeSubagents} subagent{focused.activeSubagents === 1 ? "" : "s"} working
                  </span>
                )}
                {permissionModeLabel(focused.permissionMode) && (
                  <span className="status-pill" title={`Permission mode: ${focused.permissionMode}`}>
                    {permissionModeLabel(focused.permissionMode)}
                  </span>
                )}
                {focused.sessionKind === "background" && (
                  <span className="status-pill" title="Background session (claude --bg / agent view)">background</span>
                )}
                {focused.pr && (
                  <button
                    className="status-pill link"
                    title={focused.pr.url}
                    onClick={() => post({ type: "openPullRequest", sessionId: focused.sessionId })}
                  >
                    PR{focused.pr.number ? " #" + focused.pr.number : ""}
                  </button>
                )}
                <span className="src" title={SOURCE_TITLE[focused.statusSource || "jsonl"]}>
                  {!focused.statusSource || focused.statusSource === "jsonl" ? "guessed" : "live"}
                </span>
                <span>{metaLine(focused)}</span>
              </div>

              {focusedSubs.length > 0 && (
                <div className="subs">
                  <div className="subs-head">{focusedSubs.length} active {focusedSubs.length === 1 ? "subagent" : "subagents"}</div>
                  {focusedSubs.map((s) => (
                    <div key={s.sessionId} className="sub-row" onClick={() => select(s.sessionId)}>
                      <Dot status={s.status} />
                      {s.agentType && (
                        <span className="badge sub" title={s.agentType}>
                          {shortAgentType(s.agentType)}
                        </span>
                      )}
                      <span className="sub-activity">{s.liveAction || s.lastAction || s.label}</span>
                      <span className="sub-time">{relTime(s.lastActivity)}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {focused && strip && strip.seq.length > 1 && (
            <div className="scroll-strip" title="The Scroll — every event in this session; click a tick to jump">
              <Strip
                seq={strip.seq}
                ts={strip.ts}
                total={strip.total}
                compact
                onTick={jumpToTs}
                ariaLabel="Session minimap — click a tick to jump the transcript"
              />
            </div>
          )}

          {focused && (
            <div className="transcript" ref={scrollRef}>
              {transcript.length === 0 && <div className="empty">No messages yet.</div>}
              {transcript.map((m, i) =>
                m.role === "thinking" ? (
                  <div key={i} data-i={i} className="msg thinking">
                    {m.text ? (
                      <>
                        <div className="msg-role">thinking</div>
                        <Markdown text={m.text} />
                      </>
                    ) : (
                      <div className="msg-role thinking-tag">Thinking…</div>
                    )}
                  </div>
                ) : (
                  <div key={i} data-i={i} className={"msg " + m.role}>
                    <div className="msg-role">{m.role === "tool" ? m.tool || "tool" : m.role}</div>
                    {m.role === "tool" ? (
                      <div className="msg-text">{m.text}</div>
                    ) : (
                      <Markdown text={m.text} />
                    )}
                  </div>
                ),
              )}
            </div>
          )}

          {focused && focused.kind === "session" && (
            <div className="compose">
              <textarea
                ref={composeRef}
                className="compose-box"
                placeholder="Message this session — Enter sends, Shift+Enter for a new line"
                value={composeText}
                onChange={(e) => setComposeText(e.target.value)}
                onKeyDown={(e) => {
                  // Enter while an input method is still composing a
                  // candidate commits the candidate, not the message.
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                    e.preventDefault();
                    compose();
                  }
                }}
              />
              <div className="compose-actions">
                <button className="btn tiny" disabled={!composeText.trim()} onClick={compose}>
                  Send
                </button>
                <span className="compose-note">{composeNote}</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
