# Agent View for Claude Code

A VS Code panel to **spawn, orchestrate, and monitor multiple Claude Code agents** — each
running in its own isolated git worktree/branch — without leaving your editor. Runs in
VS Code and VS Code-based IDEs (Antigravity, Cursor, Windsurf, …).

<p align="center">
  <img src="docs/agent-view.gif" alt="Agent View for Claude Code — a live tour of the Agents panel, isolated git worktrees, Agent Race (best-of-N), Fan-out, the board, and notifications" width="820">
</p>

> **Unofficial.** This is a community-built extension. It is **not affiliated with,
> endorsed by, or sponsored by Anthropic**. "Claude" and "Claude Code" are trademarks
> of Anthropic, PBC, used here only to describe interoperability. You need your own
> Claude Code installation and Claude subscription to use it.

> Status: v0.9.0 — discovery, worktree spawning, live status, the React detail view,
> desktop notifications, ambient "now doing X" status, **Agent Race** (best-of-N),
> **Fan-out**, **live plan progress**, failure detection, **Review & Land**, a **Teams
> cockpit**, **Unattended Fleet**, **Evidence Gates**, **Live presence**, a
> **Fleet Shift Report**, the **Session Board**, the **Scroll**, and the message mesh.
> New in 0.9.0 — the Attention release: a **Triage** panel sits between Agents and
> Detail and compresses your whole fleet's questions into the few you actually have
> to answer. **Claude decides which questions are the same one**, so five sessions
> asking the same thing five different ways become **one row**; one answer **resumes
> every session waiting on it**; and your answers become a **decision log** that
> answers the next session by itself. Optional **Hold** suspends an asking agent
> (burning no tokens) until you reply in the inbox. Falls back to offline matching
> if you'd rather it never called a model.
> Expect rough edges; issues and PRs welcome.

## Install

Published on the **[VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=inthepond.agent-view-for-claude-code)** and **[Open VSX](https://open-vsx.org/extension/inthepond/agent-view-for-claude-code)**.

- **Antigravity, VSCodium, Cursor, Windsurf** (Open VSX is their default registry) —
  search **"Agent View for Claude Code"** in the Extensions view, or from a terminal:
  ```bash
  antigravity --install-extension inthepond.agent-view-for-claude-code
  # same flag for: codium / cursor / windsurf
  ```
- **VS Code (Microsoft build)** — search **"Agent View for Claude Code"** in the
  Extensions view, or from a terminal:
  ```bash
  code --install-extension inthepond.agent-view-for-claude-code
  ```

**Requirements:** [Claude Code](https://claude.com/claude-code) on your `PATH`, and a Claude subscription.

## Why

Claude Code can run many sessions and subagents at once, but there's no native
in-editor way to see them all, know which one needs your input, and steer them.
Agent View gives you one **Agents** panel: a live fleet list + a detail view, plus
one-click spawning of parallel agents in clean worktrees.

## Features

- **Triage** — the middle panel, between Agents and Detail. Supervising 5-20 sessions,
  the bottleneck isn't agent capability, it's your attention: every session asks
  independently, and they ask the *same* things (package manager, branch strategy, test
  framework, what's off limits). Triage compresses that:
  - **One row per distinct question — judged by Claude.** Claude Code is already a
    requirement of this extension, so Triage uses it for the judgment word-matching
    can't make: *"install deps"* and *"install dependencies"* are one decision;
    *"tests for auth"* and *"tests for billing"* are two. Measured on a live fleet,
    three sessions asking about the package manager in three unrelated phrasings
    collapsed into a single row. Dedup is per-repo — the same question in *another*
    repo is surfaced, never merged.
  - **One answer resumes everyone** waiting on it, dispatched into each agent's terminal
    (or straight back into a held session).
  - **A decision log.** Your answer is recorded with a **scope** (this session / branch /
    repo / all repos) and an **expiry** (once / today / this week / until revoked). When a
    later session asks something the log covers, Claude confirms the recorded answer
    genuinely resolves *that* question before it is used — and the agent is handed your
    answer **verbatim**, so what the Decisions tab shows is exactly what the agent was
    told. Auditable in the **Auto** tab, revocable in **Decisions**, stored as readable
    JSON in `.agentview/triage/decisions.json`.
  - **Conservative by construction.** Scope, expiry and revocation are deterministic
    filters the engine owns — the model is never asked to second-guess them, only to
    judge content. Permission asks are never auto-answered from a general decision, file
    conflicts are never auto-answered at all, staleness hints flag decisions whose files
    have since churned or that a session re-asked, and if the auto-answer error rate
    passes 5% Triage demotes itself to dry run and tells you.
  - **Hold (opt-in).** With `mas.triage.hold.enabled`, an asking agent is suspended
    inside its own `AskUserQuestion` call until you answer in the inbox — it burns no
    tokens and does no speculative work meanwhile. If Agent View isn't running or the
    hold expires, Claude Code prompts exactly as it does today; a hold can only ever
    delay a prompt, never lose it.
  - **Conflict radar built in.** Two live sessions editing the same file raise a
    conflict row at the top of the inbox, before merge time.

  **On cost and consent:** the matching calls run `claude -p` against a cheap model and
  use your Claude subscription, so you are asked to confirm **once** and nothing runs
  before you do. They are bounded by construction — a call only happens when a *new*
  question arrives, which only happens when an agent is already blocked on you, and
  they're capped at two at a time. Set `mas.triage.ai.enabled` to `false` to run Triage
  entirely offline on lexical matching instead: it still groups, still auto-answers,
  still holds — it just misses paraphrases. That's also the automatic fallback whenever
  Claude is unreachable.
- **Agents panel** — a live tree of every Claude Code session discovered from
  `~/.claude/projects`, showing status (idle / running / thinking / needs-you), model,
  and token/cost, with a React **Detail** view of the transcript. A parent delegating to
  subagents shows **thinking** with a count of its working subagents; older idle agents
  tuck behind a one-click recency toggle (`mas.recentHours`, default 24h).
- **Live plan progress** — when an agent keeps a to-do list, its own plan shows as a
  `4/7 · <current step>` chip in the tree, the Detail view, and the Session Board — the
  agent's ground-truth "now doing X", derived from its plan with no extra LLM calls.
- **Failure detection (no LLM)** — a red **tests-red / command-failed** chip when an
  agent's most recent tool ends in failure (e.g. `Bash failed: npm test exited 1`),
  read straight from the transcript so it works for external agents too. It feeds the
  status, the tree, and the Attention Router's reason.
- **Fleet Pulse** — a one-line status-bar heartbeat (`2 running · 1 needs you · 3 idle`)
  that stays visible even when the panel is closed and turns the warning color the moment
  an agent needs you; click it to jump straight there. Toggle with `mas.statusBar.enabled`.
- **Dismiss "needs you"** — a stuck `waiting`/`error` agent can be dismissed back to idle
  inline in the tree, from the status bar ("Dismiss all"), or from the inbox. It quietly
  **resurfaces the moment the agent does something new**, so you never lose a real ask.
- **Session Board** — open any session as a board instead of a scroll (from the
  Agents toolbar). The transcript is **materialized** into objects — swim-lanes by
  type, columns by episode (one per human prompt): the prompt with its numbered
  requirements as chips, the agent's TodoWrite plan as one living object, the model's
  own notes, verification evidence, collapsed machinery counts (with silent-stall and
  unrecovered-error flags), and commit milestones. A **Glance/Detail zoom** answers
  "what happened in these three hours?" in about a dozen objects. Click objects and
  **Send** to point an agent at them — deixis instead of paraphrase; the selection
  lands in `.agentview/board/selection.json` exactly as before. Derived from a real
  materialized-session design probe (Canvas as a Conversation); everything is parsed
  from the transcript with **no LLM calls**.
- **The Scroll** — a session minimap: every conversational event as one tick, in
  order — you (amber, widest), model prose, thinking, tool calls, **agent messages
  (blue)**, results. It sits above the Detail transcript (click a tick to jump),
  tops every Session Board (click to jump to an episode), and gives each agent a
  shape line in the Fleet Shift Report. A 3-hour, 999-event session reads at a
  glance — and the six amber ticks show exactly where you steered it.
- **Teams cockpit** — a **Teams** mode on the Session Board that visualizes an active
  multi-agent run live and read-only: the **roster** of named teammates (with a `plan`
  badge for plan-approval, live status, and tokens) and the **shared task list rendered
  as a dependency graph** — a topological DAG with `owner` badges and a derived `blocked`
  state. The task graph now reads **Claude Code's native Agent Teams store**
  (`~/.claude/tasks`) when present — the TodoWrite parse stays as the fallback —
  and workflow fan-out runs show as chips.
- **Message mesh** — the cockpit's **who-told-whom timeline** of session-to-session
  messaging: native mailbox deliveries (`~/.claude/teams/<team>/inboxes`) accumulated
  even after Claude Code prunes them, merged with the lead's own `SendMessage` calls.
  Protocol traffic (shutdown requests, approvals) renders muted. The Session Board
  gets a **Messages lane** with the same traffic per episode — inbound coordinator
  messages and task notifications no longer masquerade as human prompts.
- **Spawn in isolated worktrees** — one-click **New Agent** creates a fresh git
  worktree + branch so parallel agents never clobber each other's files.
- **Live status** — Claude Code hooks stream real-time events; transcript replay is
  the zero-config fallback.
- **Ambient "now doing X"** — every agent shows a live one-liner of its current
  action ("Editing auth.ts", "Running: npm test"), derived from hook tool events
  with no extra LLM calls.
- **Live presence** — Explorer and tab badges (`AI`) on files an agent is editing
  *right now*, fading after 45s of inactivity, so you never open a file blind while
  an agent is mid-edit. `mas.presence.enabled` to turn off.
- **Notifications** — a toast (and optional chime) when an agent needs your input,
  finishes, or hits an error, so you can walk away and get pinged. Fully configurable
  under `mas.notifications.*`.
- **Agent Race (best-of-N)** — spawn N agents on the *same* prompt, each in its own
  worktree, and compare them side by side in the **Race** tab: live status, "Open all
  diffs", an optional **Rank with AI** pass, and **Pick winner** (opens its diff and
  copies the `git merge` command). Nothing is merged or deleted automatically.
- **Fan-out** — paste a checklist (or select lines in any file) and spawn one
  worktree-agent per task, capped at `mas.fanout.maxConcurrent` so the rest queue.
- **Per-agent actions** — open diff, focus terminal, or stop a managed agent inline.
- **Evidence Gates** — when a spawned agent finishes, its worktree is verified
  automatically: the project's checks (`typecheck`/`lint`/`test` scripts, `tsc`,
  cargo/go — or your own `mas.evidence.commands`) run inside the worktree and show as
  a `checks ✓` / `checks 1/3 ✗` chip in the tree and Review & Land. Evidence is
  fingerprinted against the worktree's content, so proof from before new edits reads
  `checks stale` instead of passing for current work; identical content is never
  re-verified. Auto-detected commands ask **once per repo** before ever running.
  Optional: `mas.evidence.blockLandOnRed` (hard-block landing unverified work) and
  `mas.evidence.selfRepair` (hand failing output back to the agent, capped, then
  escalated). **Run Evidence Checks** / **Show Evidence Report** in the row menu.
- **Fleet Shift Report** — a one-command briefing of what the fleet did while you
  were away: a "waiting on you" list plus a per-agent table of status, plan, diff
  size, evidence verdict, tokens, and estimated cost. Opens automatically when
  Unattended Fleet turns off. Optional consent-gated AI narrative on top
  (`mas.shiftReport.aiNarrative`, off by default).
- **Unattended Fleet** — a governed auto-pilot (toolbar toggle). Spawned agents
  **auto-accept edits** (`--permission-mode acceptEdits`) while **Bash still prompts**
  and escalates to you; agents that **stall mid-plan get nudged** to continue (capped,
  then escalated); and a **cost meter** in Fleet Pulse plus a per-agent **budget cap**
  that pauses an overrunning agent (branch/diff kept). Off by default; fully configurable
  under `mas.unattended.*`.
- **Review & Land** — a **Review** tab that turns each spawned agent's work into a
  reviewable, landable unit: every changed file as a native side-by-side diff (committed,
  uncommitted, **and** untracked, against the exact fork point), a `+/−` stat with the
  agent's plan and tests-red state, **request changes** that route back to the running
  agent, and one-click **Squash-merge** / **Open PR** (`gh`, with a copy-link fallback).
  Landing is off by default (`mas.review.allowLand`), refuses a dirty base, snapshots
  uncommitted work so what you reviewed is what lands, and is reversible until you push —
  nothing is auto-merged and no branch is ever deleted.
- **Opt-in AI helpers** (off by default, consent-gated before first run):
  - **Conflict Radar** — local-only; flags files edited by more than one agent.
  - **Attention Router** — triages which agent needs you into a "Needs you" inbox.
    Runs `claude -p` and uses your Claude subscription.
  - **Merge Advisor** — ranks multiple agents' diffs and recommends which to merge.
    Uses your Claude subscription.

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ VS Code extension host (TypeScript, esbuild → dist/)         │
│                                                              │
│  data layer            orchestration         live status     │
│  ───────────           ─────────────         ───────────     │
│  discovery.ts          worktree.ts           hooks/server.ts │
│  transcript.ts         spawn.ts              (HTTP, push)    │
│  subagents.ts          registry.ts           hooks/installer │
│  store.ts (fs.watch)   terminals.ts                          │
│        │                                                     │
│        ├──► AgentsProvider (native TreeView: mas.agents)     │
│        ├──► TriageViewProvider (React inbox:  mas.triage) ◄┤ │
│        └──► WebviewProvider (React detail:    mas.detail) ◄┐ │
└───────────────────────────────────────────────────────────┼─┘
                                                webview-ui/ (React + Vite)
```

The sidebar is three equal thirds: **Agents** (who is running), **Triage** (what needs
you), **Detail** (what one agent is doing). `src/triage/` holds the pipeline —
normalize, dedup, decision-log lookup, route — plus the on-disk decision log and the
blocking Hold channel. `judge.ts` is the Claude-backed adjudicator; `text.ts` is the
offline lexical matcher that shortlists candidates for it and takes over entirely when
Claude is off or unreachable.

Opt-in AI layer (off by default): `src/features/{router,mergeAdvisor,conflicts}` plus
`src/llm/runner.ts` power the "Needs you" inbox, Merge Advisor, and Conflict Radar.

### Data sources (fidelity order)
1. **Claude Code hooks** (push, low-latency) — installed into `~/.claude/settings.json`,
   POST events to the local hook server. Drives real-time status.
2. **Session JSONL transcripts** (pull/replay, zero-config) —
   `~/.claude/projects/<enc-cwd>/<session-id>.jsonl` plus
   `<session-id>/subagents/**/agent-*.jsonl`. Source of truth + fallback.

For agents the extension spawns, we pass `claude --session-id <uuid>` so each agent maps
deterministically to its transcript file.

## Develop

```bash
npm install
npm run build        # builds the React webview (Vite) + the extension (esbuild)
# then press F5 in VS Code to launch the Extension Development Host
```

Or iterate on just the extension host:

```bash
npm run watch        # esbuild watch
npm run typecheck    # tsc --noEmit
```

## Contributing

Issues and pull requests are welcome — this is an unofficial community project.
Build from source (above), then open a PR against `main`.

## License

Apache-2.0 — see [LICENSE](LICENSE). Adapted OSS components are credited in [NOTICE](NOTICE).
