import { useEffect, useMemo, useState } from "react";
import { post } from "./api";
import type {
  AnswerExpiry,
  AnswerScope,
  AutoRow,
  DecisionRow,
  ExtToTriage,
  QuestionKind,
  TriageRow,
  TriageState,
  TriageStats,
} from "./protocol";

type Tab = "inbox" | "auto" | "decisions";

const KIND_LABEL: Record<QuestionKind, string> = {
  conflict: "conflict",
  permission: "permission",
  ask: "question",
};

const SCOPES: { value: AnswerScope; label: string; hint: string }[] = [
  { value: "session", label: "this session", hint: "Only the session that asked." },
  { value: "branch", label: "this branch", hint: "Any session on this branch." },
  { value: "repo", label: "this repo", hint: "Any session in this repo." },
  { value: "global", label: "all repos", hint: "Every repo you supervise." },
];

const EXPIRIES: { value: AnswerExpiry; label: string; hint: string }[] = [
  { value: "once", label: "once", hint: "Answer now; nothing is remembered." },
  { value: "today", label: "today", hint: "Reusable until midnight." },
  { value: "week", label: "this week", hint: "Reusable for seven days." },
  { value: "forever", label: "until revoked", hint: "Reusable until you revoke it." },
];

function relTime(ms: number): string {
  if (!ms) return "—";
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function scopeText(d: DecisionRow): string {
  const bits: string[] = [];
  if (d.scope.sessionId) bits.push("one session");
  else if (d.scope.branch) bits.push(d.scope.branch);
  else if (d.scope.repo) bits.push(d.scope.repo.split("/").pop() || d.scope.repo);
  else bits.push("all repos");
  if (d.scope.pathGlob) bits.push(d.scope.pathGlob);
  return bits.join(" · ");
}

/** One open Cluster: the raw asks, the answer box, and the scope it will get. */
function InboxCard({
  row,
  defaultScope,
  defaultExpiry,
}: {
  row: TriageRow;
  defaultScope: AnswerScope;
  defaultExpiry: AnswerExpiry;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<AnswerScope>(defaultScope);
  const [expiry, setExpiry] = useState<AnswerExpiry>(defaultExpiry);

  // A conflict has no answer to remember — it is a heads-up, not a decision.
  const answerable = row.kind !== "conflict";
  const send = (text: string) => {
    const answer = text.trim();
    if (!answer) return;
    post({ type: "answer", clusterId: row.id, answer, scope, expiry });
    setDraft("");
  };

  return (
    <div className={`t-card ${row.kind}`}>
      <button className="t-card-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className={`t-pip ${row.kind}`} title={KIND_LABEL[row.kind]} />
        <span className="t-intent">{row.intent}</span>
        {row.waiting.length > 1 && (
          <span className="t-count" title={`${row.waiting.length} sessions are waiting on this one answer`}>
            {row.waiting.length}
          </span>
        )}
        <span className="t-chevron">{open ? "−" : "+"}</span>
      </button>

      <div className="t-card-meta">
        <span className="t-tag">{row.category}</span>
        <span className="t-repo" title={row.repo}>
          {row.repoName}
          {row.branch ? ` · ${row.branch}` : ""}
        </span>
        {row.waiting.some((w) => w.held) && (
          <span className="t-tag held" title="These sessions are suspended, waiting on you. They burn no tokens while held.">
            held
          </span>
        )}
        {row.alsoInRepos > 0 && (
          <span className="t-tag" title="The same question is open in other repos. Never merged — the answers usually differ.">
            also in {row.alsoInRepos} repo{row.alsoInRepos === 1 ? "" : "s"}
          </span>
        )}
        <span className="t-age">{relTime(row.createdAt)}</span>
      </div>

      {row.suggestion && (
        <div className="t-suggest" title={row.suggestion.why}>
          <b>From your decision log:</b> {row.suggestion.answer}
          <div className="t-suggest-why">{row.suggestion.why}</div>
          {answerable && (
            <button className="t-btn tiny" onClick={() => send(row.suggestion!.answer)}>
              Use this answer
            </button>
          )}
        </div>
      )}

      {open && (
        <div className="t-raw">
          {row.waiting.map((w) => (
            <div key={w.questionId} className="t-raw-row">
              <button className="t-link" onClick={() => post({ type: "openSession", sessionId: w.sessionId })}>
                {w.label}
              </button>
              <pre className="t-raw-text">{w.text}</pre>
              {row.waiting.length > 1 && (
                <button
                  className="t-btn ghost tiny"
                  title="Not the same question — pull it out into its own row"
                  onClick={() => post({ type: "split", clusterId: row.id, questionId: w.questionId })}
                >
                  Split
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {answerable && row.options.length > 0 && (
        <div className="t-options">
          {row.options.map((o) => (
            <button key={o} className="t-btn tiny" onClick={() => send(o)} title={`Answer "${o}"`}>
              {o}
            </button>
          ))}
        </div>
      )}

      {answerable ? (
        <div className="t-answer">
          <textarea
            className="t-input"
            rows={2}
            placeholder={
              row.waiting.length > 1
                ? `Answer once — resumes all ${row.waiting.length} sessions`
                : "Your answer"
            }
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") send(draft);
            }}
          />
          <div className="t-answer-row">
            <select
              className="t-select"
              value={scope}
              onChange={(e) => setScope(e.target.value as AnswerScope)}
              title={SCOPES.find((s) => s.value === scope)?.hint}
            >
              {SCOPES.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
            <select
              className="t-select"
              value={expiry}
              onChange={(e) => setExpiry(e.target.value as AnswerExpiry)}
              title={EXPIRIES.find((x) => x.value === expiry)?.hint}
            >
              {EXPIRIES.map((x) => (
                <option key={x.value} value={x.value}>
                  {x.label}
                </option>
              ))}
            </select>
            <button className="t-btn primary tiny" disabled={!draft.trim()} onClick={() => send(draft)}>
              Answer
            </button>
            <button
              className="t-btn ghost tiny"
              title="Drop this from Triage. Anything held falls through to Claude Code's own prompt."
              onClick={() => post({ type: "dismiss", clusterId: row.id })}
            >
              Dismiss
            </button>
          </div>
        </div>
      ) : (
        <div className="t-answer-row">
          {row.waiting.map((w) => (
            <button
              key={w.sessionId}
              className="t-btn tiny"
              onClick={() => post({ type: "openSession", sessionId: w.sessionId })}
            >
              Open {w.label.slice(0, 20)}
            </button>
          ))}
          <button className="t-btn ghost tiny" onClick={() => post({ type: "dismiss", clusterId: row.id })}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}

function AutoCard({ row }: { row: AutoRow }) {
  return (
    <div className={`t-card auto${row.bumped && !row.reviewed ? " bumped" : ""}`}>
      <div className="t-card-head static">
        <span className={`t-pip ${row.dryRun ? "dry" : "auto"}`} />
        <span className="t-intent">{row.intent}</span>
        <span className="t-age">{relTime(row.at)}</span>
      </div>
      <div className="t-answered">{row.answer}</div>
      <div className="t-card-meta">
        <span className="t-tag">{row.dryRun ? "dry run — not sent" : "auto-answered"}</span>
        <span className="t-repo">{row.sessions.join(", ")}</span>
      </div>
      <div className="t-answer-row">
        {!row.reviewed && (
          <button className="t-btn ghost tiny" onClick={() => post({ type: "reviewAuto", clusterId: row.clusterId })}>
            Looks right
          </button>
        )}
        <button
          className="t-btn tiny danger"
          title="Revoke the decision behind this so it never answers for you again"
          onClick={() => post({ type: "undoAuto", clusterId: row.clusterId })}
        >
          Wrong — revoke
        </button>
      </div>
    </div>
  );
}

function DecisionCard({ row }: { row: DecisionRow }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.answer);
  const dead = !!row.revokedAt || row.expired;

  return (
    <div className={`t-card decision${dead ? " dead" : ""}`}>
      <div className="t-card-head static">
        <span className={`t-pip ${row.kind}`} />
        <span className="t-intent">{row.intent}</span>
        <span className="t-age" title={`Used ${row.hitCount} time${row.hitCount === 1 ? "" : "s"}`}>
          {row.hitCount ? `${row.hitCount}x` : "unused"}
        </span>
      </div>

      {editing ? (
        <div className="t-answer">
          <textarea className="t-input" rows={2} value={draft} onChange={(e) => setDraft(e.target.value)} />
          <div className="t-answer-row">
            <button
              className="t-btn primary tiny"
              onClick={() => {
                post({ type: "editDecision", decisionId: row.id, answer: draft });
                setEditing(false);
              }}
            >
              Save
            </button>
            <button className="t-btn ghost tiny" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="t-answered">{row.answer}</div>
      )}

      <div className="t-card-meta">
        <span className="t-tag">{scopeText(row)}</span>
        <span className="t-tag">
          {row.revokedAt
            ? "revoked"
            : row.expired
              ? "expired"
              : row.expiresAt
                ? `until ${new Date(row.expiresAt).toLocaleDateString()}`
                : "until revoked"}
        </span>
        <span className="t-age">{relTime(row.createdAt)}</span>
      </div>

      {row.staleReason && !dead && (
        <div className="t-stale">
          This decision may be stale — {row.staleReason}.
          <div className="t-answer-row">
            <button className="t-btn tiny" onClick={() => post({ type: "confirmDecision", decisionId: row.id })}>
              Still right
            </button>
            <button
              className="t-btn tiny danger"
              onClick={() => post({ type: "revokeDecision", decisionId: row.id, reason: "Stale" })}
            >
              Revoke
            </button>
          </div>
        </div>
      )}

      {!dead && !editing && (
        <div className="t-answer-row">
          <button className="t-btn ghost tiny" onClick={() => setEditing(true)}>
            Edit
          </button>
          <button
            className="t-btn ghost tiny danger"
            onClick={() => post({ type: "revokeDecision", decisionId: row.id })}
          >
            Revoke
          </button>
        </div>
      )}
    </div>
  );
}

function StatsBar({ stats, dryRun }: { stats: TriageStats; dryRun: boolean }) {
  const holdMin = stats.medianHoldMs ? Math.round(stats.medianHoldMs / 60000) : 0;
  return (
    <div className="t-stats" title="Measured from real traffic, not estimated.">
      <span title="Clusters you answered / questions asked. Lower is better.">
        compression <b>{stats.rawQuestions ? pct(stats.compression) : "—"}</b>
      </span>
      <span title="Questions answered from the decision log without you.">
        auto <b>{stats.rawQuestions ? pct(stats.autoHitRate) : "—"}</b>
      </span>
      <span
        className={stats.circuitOpen ? "bad" : undefined}
        title="Auto-answers you later revoked or edited. Above 5% forces dry run."
      >
        error <b>{stats.autoAnswers ? pct(stats.autoErrorRate) : "—"}</b>
      </span>
      <span title="Median time a session waited for you. Informational.">
        wait <b>{stats.medianHoldMs ? (holdMin ? `${holdMin}m` : "<1m") : "—"}</b>
      </span>
      {dryRun && <span className="t-tag dry">dry run</span>}
    </div>
  );
}

export function TriageApp() {
  const [state, setState] = useState<TriageState | null>(null);
  const [tab, setTab] = useState<Tab>("inbox");

  useEffect(() => {
    const onMsg = (e: MessageEvent<ExtToTriage>) => {
      if (e.data?.type === "state") setState(e.data.state);
    };
    window.addEventListener("message", onMsg);
    post({ type: "ready" });
    return () => window.removeEventListener("message", onMsg);
  }, []);

  const liveDecisions = useMemo(
    () => (state?.decisions || []).filter((d) => !d.revokedAt && !d.expired),
    [state],
  );
  const unreviewed = useMemo(() => (state?.auto || []).filter((a) => !a.reviewed).length, [state]);

  if (!state) return <div className="t-empty">Loading…</div>;

  if (!state.enabled) {
    return (
      <div className="t-empty">
        Triage is off. Turn on <code>mas.triage.enabled</code> to compress your agents' questions
        into one inbox.
      </div>
    );
  }

  return (
    <div className="t-app">
      <header className="t-tabs">
        <button className={"t-tab" + (tab === "inbox" ? " active" : "")} onClick={() => setTab("inbox")}>
          Inbox{state.inbox.length ? ` ${state.inbox.length}` : ""}
        </button>
        <button className={"t-tab" + (tab === "auto" ? " active" : "")} onClick={() => setTab("auto")}>
          Auto{unreviewed ? ` ${unreviewed}` : ""}
        </button>
        <button
          className={"t-tab" + (tab === "decisions" ? " active" : "")}
          onClick={() => setTab("decisions")}
        >
          Decisions{liveDecisions.length ? ` ${liveDecisions.length}` : ""}
        </button>
        <span className="t-spacer" />
        <span
          className={"t-tag" + (state.ai ? " ai" : "")}
          title={
            state.ai
              ? "Claude is judging whether two agents are asking the same question, and whether a recorded decision answers a new one. Offline matching is the fallback."
              : "Matching offline on text alone. Turn on mas.triage.ai.enabled to let Claude judge instead."
          }
        >
          {state.ai ? "claude" : "offline"}
        </span>
        <label className="t-dry" title="Log what auto-answer would have done, but still ask you. Recommended for the first week.">
          <input
            type="checkbox"
            checked={state.dryRun}
            disabled={state.stats.circuitOpen}
            onChange={(e) => post({ type: "setDryRun", on: e.target.checked })}
          />
          dry run
        </label>
      </header>

      <div className="t-body">
        {tab === "inbox" &&
          (state.inbox.length === 0 ? (
            <div className="t-empty">
              Nothing needs you. Questions from every session land here, deduplicated — one answer
              resumes everyone waiting on it.
              {state.holdEnabled && !state.hooksInstalled && (
                <p className="t-warn">
                  Hold is on but the Claude Code hooks aren't installed, so nothing can be suspended.
                  Run <b>Configure Claude Code Hooks</b>.
                </p>
              )}
            </div>
          ) : (
            state.inbox.map((row) => (
              <InboxCard
                key={row.id}
                row={row}
                defaultScope={state.defaultScope}
                defaultExpiry={state.defaultExpiry}
              />
            ))
          ))}

        {tab === "auto" &&
          (state.auto.length === 0 ? (
            <div className="t-empty">
              Nothing has been answered from the decision log yet. Answer a question with a scope
              wider than <b>once</b> and the next session that asks it gets the answer directly.
            </div>
          ) : (
            state.auto.map((row) => <AutoCard key={row.clusterId} row={row} />)
          ))}

        {tab === "decisions" &&
          (state.decisions.length === 0 ? (
            <div className="t-empty">
              No decisions recorded yet. They are stored in{" "}
              <code>.agentview/triage/decisions.json</code> — readable, diffable, and yours to edit.
            </div>
          ) : (
            state.decisions.map((row) => <DecisionCard key={row.id} row={row} />)
          ))}
      </div>

      <StatsBar stats={state.stats} dryRun={state.dryRun} />
    </div>
  );
}
