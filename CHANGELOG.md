# Changelog

All notable changes to **Agent View for Claude Code** are documented here.
This project adheres to [Semantic Versioning](https://semver.org/).

## [0.10.0] — 2026-10-06

The Native Signals release. Claude Code moved from 2.1.196 to 2.1.289 since Agent
View last caught up, and a lot of what Agent View used to *infer* is now something
Claude Code *records*. This release reads it, and fixes what the drift broke.

### Added

- **Live status from Claude Code's own session state.** Claude Code keeps a registry
  of running sessions in `~/.claude/sessions/` — the same source `claude agents` reads.
  Agent View now reads it (read-only) for **busy / idle / waiting** with no hooks
  installed, across other windows, the Claude Code extension and background sessions.
  Entries left by crashed processes are ignored: the pid must be alive *and* still
  belong to the process that wrote the entry (its start time is checked, as Claude
  Code does, so a reused pid can't revive a dead session); where the pid can't be
  checked, the entry must be fresh. Against hook events, whichever changed most
  recently wins. Off with `mas.sessionRegistry.enabled`.
- **The exact ask.** A waiting session shows what it is waiting on, verbatim, in the
  tree, the Detail view and the "Needs you" reason.
- **Your `/rename` titles.** A title you give a session wins over the generated one.
  The `--name` Agent View passes at spawn is recognised and not mistaken for yours.
- **PR, permission-mode and background chips.** `PR #123` when Claude Code linked a
  pull request (click to open it in the Detail view), `plan mode` / `accept edits` /
  `bypass perms` for non-default modes, `bg` for background sessions. The tooltip adds
  the session's messaging address, where it runs, and its cost.
- **API trouble, named.** A session stuck retrying the API shows "API retry 3/10:
  Overloaded" instead of its last action, and turns red with Claude Code's own message
  when a call fails for good (retries spent, "You've hit your session limit", signed
  out).
- **Plan progress from the Task tools.** Current models plan with `TaskCreate` /
  `TaskUpdate`, not `TodoWrite`. Plan chips, Session Board plans and the Teams fallback
  task list now read both. The plan is read from the whole transcript (incrementally),
  since the Task tools build it one call at a time and a tail read of a long session
  would see only part of it.
- **`mas.spawn.planTools`** (default on): agents Agent View spawns get
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`. Since 2.1.268 Claude Code offers plan tools on
  current models (Opus 4.8+, Sonnet 5+, Fable) only with it set — without them, plan
  progress was blank and Unattended's stuck-agent nudge could never fire.
- Readable phrases for the tools agents now call routinely: Workflow, Monitor,
  TaskCreate / TaskUpdate / TaskList / TaskStop, Skill, SubagentHandback,
  Enter/ExitWorktree, ExitPlanMode, ScheduleWakeup and others.

### Changed

- **Triage is opt-in.** `mas.triage.enabled` now defaults to off, and the Triage view
  starts collapsed on a fresh install, so the sidebar opens as Agents over Detail. Turn
  it on from the panel's **Turn on Triage** button or **Agent View: Turn On Triage**;
  **Turn Off Triage** sits in the panel's `...` menu. While off it records and writes
  nothing. If you used Triage under 0.9.x without ever setting the option, Agent View
  asks once whether to keep it on, so an upgrade never takes it away silently.
- **Cost now matches Claude Code's `/cost`.** Every API message is counted once (a
  message spans several transcript lines that all repeat its usage — output tokens were
  counted 2-3x), across the whole transcript (cache reads were previously counted for
  the last turn only), at current list prices: Opus 5.5 $4/$20, Opus 4.x/5 $5/$25,
  Sonnet 5/5.5 $2/$10, Fable 5.1 $10/$50, Haiku 4.5 $1/$5, with 1-hour cache writes at
  2x input. Subagents are included. Claude Code's own per-process cost snapshots are
  folded in too — they see calls no transcript records (the auto-mode safety classifier,
  compaction) — and the larger of the two figures wins. Checked against those
  snapshots, single-run sessions agree within 3%. Across resumes Agent View counts the
  whole session, which `/cost` does not. Unattended's budget cap and the Shift Report
  use the new figure. **If you set `mas.unattended.maxCostUsd`, revisit it** — the old
  estimate missed most cache reads, so on long sessions the real figure is often
  several times higher and an old cap may pause agents sooner than you expect.
  `mas.unattended.pricing` now takes a `fable` key and is only needed for negotiated
  rates.
- **AI helpers run as bare text models.** The Attention Router, Merge Advisor, Shift
  Report narrative and Triage's judge now call `claude -p` with no tools, no MCP
  servers or skills, a one-line system prompt and no session file
  (`--tools "" --strict-mcp-config --disable-slash-commands --system-prompt …
  --no-session-persistence`, on CLI 2.1.143+). They only ever judged text they were
  handed. This also closes a gap: since 2.1.285, print mode on third-party providers
  can default to auto mode, which would have let a prompt-injected transcript run
  tools. Context per call drops from tens of thousands of tokens to a few hundred.
  Helper runs no longer show up as agents in the fleet.
- Agent Teams: the roster reads `config.json`'s current camelCase fields (`agentId`,
  `agentType`), and a team is matched to its lead by `leadSessionId` when recorded
  (roster-name overlap is still the fallback). A team whose teammates run in-process
  now attaches to its lead's session, and the shared task list reads dependencies
  from `blockedBy`, the key Claude Code actually writes.

### Fixed

- **`agent_needs_input` / `agent_completed` notifications** (2.1.198+) flipped
  sessions to *running*. They are emitted by Claude Code's fleet view about a
  background job but carry the fleet view's own session id, so they no longer change
  any status — the job's own state comes from the registry. MCP elicitation prompts
  read as waiting, and notification kinds that say nothing about state (like
  `auth_success`) no longer flip a session to running.
- **A finishing subagent no longer marks its parent idle** or clears its "now doing"
  line. Subagents run in the background by default since 2.1.198, so `SubagentStop`
  says nothing about the parent.
- **Compaction summaries are no longer treated as something you typed.** They don't
  become a session's label, a "human prompt" tick on the Scroll, or a pages-long user
  message in the Detail view, which now shows a "Context compacted" marker instead.
  Background-task notifications are likewise no longer counted as prompts.

## [0.9.2] — 2026-08-27

Triage stops writing into your project.

0.9.0 and 0.9.1 put `.agentview/triage/` in the workspace unconditionally — and
because the metric counters tick on the *first question any agent asks*, the
files appeared whether or not you ever opened the panel. That is not a panel's
place to put anything, and it forced a `.gitignore` entry on people who never
asked for one.

### Changed

- **`mas.triage.storage`, defaulting to `internal`.** Triage now keeps its state
  in VS Code's private per-workspace storage. **Nothing is written into your
  project**, and there is nothing to gitignore. Set it to `repo` to opt into
  `.agentview/triage/decisions.json` when you want the decision log committed
  and shared with your team.
- **Metrics are never repo-local**, even in `repo` mode. They are per-machine
  counters and would only ever be merge noise, so `repo` mode adds exactly one
  file to your project — the decision log, the part actually worth sharing.
- **Existing logs are carried over.** A `.agentview/triage/decisions.json` left
  by 0.9.0/0.9.1 is adopted on first read; the original is left in place for you
  to delete, since it is your repo.
- Changing the setting takes effect immediately — no window reload.
- The Decisions tab now shows where the log actually lives, so it is never a
  mystery.
- Dropped the `.agentview/triage/metrics.json` line this project's own
  `.gitignore` had needed.

### Notes

`mas.triage.enabled: false` has always prevented every write, and still does —
intake, hooks, and holds all return before touching disk. Deleting an existing
`.agentview/triage/` directory is safe at any time.

## [0.9.1] — 2026-08-27

Closes the obvious hole in 0.9.0: **you often answer at the session, not in the
inbox.** Triage now notices, reads the answer back, and offers to keep it —
instead of silently dropping the row and letting the next session ask the same
thing again.

### Added

- **Answered-at-the-session capture.** When a question leaves the inbox because
  its session resumed, Triage reads the answer out of the transcript
  (`toolUseResult.answers`, with the result sentence as fallback) and offers it
  under **"Answered at the session — keep these?"** at the bottom of the Inbox.
  **Remember** records it as a normal Decision with the usual scope and expiry;
  **One-off** discards it. The Decision Log now builds itself however you answer.
- **Remember + resume.** If other sessions are still parked on the same
  question, the captured row says so and offers to send them the answer you
  already gave — the compression still happens even though you answered in a
  terminal. Offered, never automatic.
- **`at session` metric.** Questions resolved outside the inbox are counted and
  shown, and they count in the compression numerator: you were still
  interrupted, so a ratio that ignored them would flatter the day.

### Fixed

- **No more stray answers into a moved-on session.** Answering a row whose
  session had already resumed would type the answer into its terminal,
  interrupting whatever it started next with a reply to a question it no longer
  had. Dispatch now skips any session that is no longer waiting.
- **A held agent no longer looks hung.** With Hold on, Claude Code has not
  reached its own prompt yet, so the session prints nothing and anyone looking
  at it sees a stall. Held sessions now narrate "Waiting on your answer in
  Triage" in the tree and Detail, cleared however the hold ends (answered,
  expired, or dismissed).
- `toolUseId` is carried onto cluster members, without which the capture above
  could never find the answer.

## [0.9.0] — 2026-08-27

The Attention release: **Triage**, a third sidebar panel between Agents and
Detail (the three now split the sidebar into equal thirds). When you supervise
5-20 sessions the bottleneck is not agent capability, it is your attention:
every session asks independently, and they ask the same things. Triage
compresses N sessions' questions down to the distinct ones, and remembers your
answers so the next session does not have to ask at all.

Claude Code is already a hard requirement of this extension, so Triage uses it
for the judgment that makes the feature work: **is this the same question
another agent already asked?** Word overlap cannot answer that — "install deps"
and "install dependencies" are one decision, "tests for auth" and "tests for
billing" are two. An offline lexical matcher shortlists candidates for the model
and takes over entirely when it is off or unreachable.

### Added

- **Triage panel (`mas.triage`).** Three tabs: **Inbox** (open questions),
  **Auto** (what was answered from the log, for review), **Decisions** (the log
  itself). A footer shows the real metrics — interrupt compression, auto-answer
  hit rate, auto-answer error rate, median wait.
- **Question intake, two sources.** Explicit asks are read from
  `AskUserQuestion` tool calls and permission `Notification` hook events, with
  the session transcript as the zero-config fallback so it works without hooks
  installed. Implicit ones are file collisions between two live sessions,
  raised as `conflict` rows.
- **Dedup, adjudicated by Claude.** Questions are normalized (session-specific
  detail — line numbers, absolute paths, hashes — stripped) and grouped within a
  repo, so "3 sessions are waiting on this" is one row. The lexical measure
  shortlists which open rows are worth asking about and settles the
  near-identical cases without a call; Claude decides the rest. On a live fleet,
  three sessions asking about the package manager in three unrelated phrasings
  (lexically 0.55-0.76, all below the merge threshold) collapsed into one row.
  The same question in *another* repo is surfaced ("also in 2 repos") but never
  merged: the answers usually differ. A mis-merge can be **split** back apart by
  hand.
- **One answer resumes everyone** in the cluster, dispatched into each agent's
  terminal — or straight back into a held session.
- **Decision Log.** Answers are recorded with a scope (this session / branch /
  repo / all repos) and an expiry (once / today / this week / until revoked) in
  `.agentview/triage/decisions.json` — readable, diffable, hand-editable JSON,
  partitioned by repo. **Export Triage Decisions** renders it as markdown.
- **Auto-answer, model-confirmed.** A new question that matches a live, in-scope
  decision is answered without you — but only after Claude confirms the recorded
  answer genuinely resolves *that* question, with the prompt told to return false
  on partial coverage or any doubt. The agent is handed your answer **verbatim**;
  the model only ever returns yes/no, so what the Decisions tab shows is exactly
  what the agent was told. Auditable in the Auto tab, one-click revoke.
  `mas.triage.autoAnswer.dryRun` logs what *would* have happened while still
  asking you — recommended for the first week.
- **Hold (opt-in, `mas.triage.hold.enabled`).** Installs a blocking
  `AskUserQuestion` hook so an asking agent is suspended until you answer in the
  inbox — burning no tokens and doing no speculative work meanwhile. Every
  failure path (extension not running, port taken, hold expired, you dismiss the
  row) prints nothing and exits 0, which Claude Code treats as "no decision" and
  prompts as it does today. **A hold can only ever delay a prompt, never lose
  one.** Re-run **Configure Claude Code Hooks** after changing the setting; the
  extension offers to do it for you and never rewrites `~/.claude/settings.json`
  unprompted.
- **Staleness hints (never automatic expiry).** A decision is flagged when the
  files under its path scope have churned substantially since it was made, or
  when a session re-asked a reworded version right after being auto-answered.
  One click to confirm or revoke.
- **Error-rate circuit breaker.** Auto-answers you later revoke or edit are
  counted; past a 5% error rate (with a 10-answer minimum sample) auto-answer
  demotes itself to dry run and says so. It recovers on its own once the bad
  decisions are cleaned up.

### Changed

- The Agent View sidebar now contributes **three views** — Agents, Triage,
  Detail — each with `initialSize: 1`, so they open as equal thirds.
- `installHooks(port, opts)` takes options and can install Triage's blocking
  hook; `HookServer` gained a second `/mas-triage` endpoint that holds its
  response open. Both are additive — existing hooks and behavior are unchanged
  when Hold is off, and MAS hook removal still leaves your own hooks alone.

### Notes on the design

Departures from the Triage spec, all documented in the code:

- **Matching is Claude, not embeddings.** The spec reaches for an embedding
  model and cosine thresholds. This uses the model that is already installed:
  `claude -p` against a Haiku-class model, asked two narrow yes/no questions —
  "would one answer satisfy both agents?" and "does this standing decision
  already answer this?". That is strictly better than cosine at the thing the
  spec's risk table worries most about (collapsing two different questions into
  one), and it needs no new dependency, model download, or index.

  Cost is bounded by construction: a call only happens when a *new* question
  arrives, which only happens when an agent is already blocked on a human, so
  latency is free and the spend is negligible next to the stalled agent. Calls
  are capped at two concurrent and at three candidates per question.

- **Lexical matching is the prefilter and the fallback, not the decision.**
  `text.ts` (token Jaccard with light stemming, character-trigram cosine, entity
  overlap) ranks which candidates are worth a call and settles the near-identical
  cases without one. With AI off, declined, or unreachable it becomes the whole
  decision — Triage keeps working offline, it just misses paraphrases. Its
  thresholds were recalibrated for that role: the spec's 0.88 / 0.92 were named
  for embedding cosine and do not transfer, so the defaults are **0.70 (dedup)**
  and **0.80 (lookup)**, preserving the property the spec cares about — that
  auto-answer is strictly stricter than merging.

- **The model judges content; the engine judges scope.** Repo, branch, path,
  expiry and revocation are deterministic filters applied before any call, and
  the prompts are deliberately not shown the scope. An early version passed it
  in and the model rejected a perfectly valid match by second-guessing a check
  that had already passed.

- **Storage is JSON, not SQLite + sqlite-vec.** A VS Code extension cannot ship
  a native module without breaking on some platform it has to run on, the v0
  data volume is tiny, and a readable file is one you can diff, commit, and fix
  by hand.

- **`mas.triage.ai.enabled` defaults on**, unlike every other AI helper here.
  Judging sameness *is* the feature, so an off-by-default version would ship
  broken. It is still behind the same one-time consent modal — nothing calls a
  model until you say yes once — and declining leaves you with the offline
  matcher rather than a dead panel.

## [0.8.0] — 2026-08-10

The Communication release: Claude Code's session-to-session messaging (Agent
Teams mailboxes + the SendMessage plane) becomes visible. Everything here is
read-only against `~/.claude` — Claude Code owns those stores; MAS only
observes. Shapes were captured from a real team run (Claude Code 2.1.196) and
all parsers stay defensive: the store is experimental and shifts often.

### Added

- **Native Agent Teams store readers.** `~/.claude/teams/<team>/` (roster from
  `config.json` when the CLI writes one, mailbox inboxes always) and
  `~/.claude/tasks/<team>/` (shared task list, tolerant of key drift) now feed
  the Teams cockpit. When a native team matches a live session (roster-name
  overlap), its task list **wins over the TodoWrite fallback** and the source
  chip flips to `native store`; unmatched-but-fresh native teams still surface
  as store-only entries. The cockpit updates live via its own watcher on
  `~/.claude/teams` (the projects watcher never covered it).
- **Message mesh timeline.** The Teams cockpit gains a who-talked-to-whom
  timeline: mailbox deliveries (accumulated in memory across Claude Code's
  pruning — messages survive being consumed) merged with the lead's own
  `SendMessage` calls from its transcript. Structured protocol traffic
  (shutdown requests, approvals) renders muted and labeled.
- **Messages in every projection surface.** `SendMessage` humanizes to
  "Messaging scout: …" in the tree/detail; the Scroll gets a blue
  **agent-message tick** (`◆` in the Shift Report glyph line); the Session
  Board gets a **Messages lane** — outbound sends and inbound
  coordinator/task-notification deliveries as selectable, sendable objects,
  with a messages count in the header.
- **Inbound traffic no longer masquerades as you.** Coordinator messages and
  background-task notifications arrive in transcripts as user-type lines;
  they previously counted as human prompts — polluting the Scroll's amber
  anchors and falsely splitting board episodes. They now classify as
  agent-message events.
- **Team hook events.** `TeammateIdle`, `TaskCreated`, `TaskCompleted` are
  installed with the MAS hooks (harmless on older CLIs) and narrate the lead's
  row live ("Teammate scout is idle", "Task done: alpha") — each also ticks
  the cockpit refresh. They never override session status.
- **Addressable spawns.** Managed agents get `--name <branch>` when the
  installed CLI supports it (2.1.224+, version-probed and cached — older CLIs
  abort on unknown flags, so the flag is omitted rather than risked), giving
  them stable, human-readable addresses in `ListAgents`/`SendMessage`.

## [0.7.0] — 2026-07-16

The CaaC release: a session is a workspace, not a scroll. Two new surfaces —
derived from hand-replaying a real 3.5-hour session onto a board (Canvas-as-a-
Conversation probe 01) — make long sessions legible at a glance. Both are pure
transcript projection: no LLM calls, no new network surface.

### Changed

- **The Session Board replaces the Pinboard.** `Agent View: Open Session Board`
  (same command id, `mas.openCanvas`) now opens a fleet list; picking a session
  **materializes its transcript into board objects** in swim-lanes by type,
  columns by episode (one per human prompt): the prompt with its numbered
  requirements parsed into chips, the TodoWrite plan as one living object, the
  model's own prose notes, verification evidence, collapsed machinery counts
  (with silent-stall and unrecovered-error flags), and `[branch hash]` commit
  milestones. A **Glance/Detail zoom** switches between the spine-and-commits
  view and the full board. Click objects and **Send** to point an agent at them
  — selection still travels `.agentview/board/selection.json`, so existing
  agent-side instructions keep working. The **Teams cockpit is unchanged**
  (same dock toggle).
- The free-form pin canvas (pinned diff/note cards, arrows) is retired. Old
  `.agentview/board/` files are left untouched on disk; `inbox/<id>.json`
  posts from agents now surface as a notification instead of a card.

### Added

- **The Scroll — a session minimap.** Every conversational event as one tick,
  in order: you (amber, widest), model prose, thinking, tool calls, results.
  It renders above the Detail transcript (click a tick to jump), at the top of
  every Session Board (click to jump to the episode), and per-agent in the
  Fleet Shift Report as a glyph line (`█ you · ¶ prose · ▒ thinking · ▪ tool ·
  · result`). Sessions longer than 4000 events downsample; human ticks always
  survive — they are the anchors.

## [0.6.0] — 2026-07-14

The Trust release: agents don't just finish — they finish with **proof**. Three
features attack the real bottleneck of multi-agent work (verifying it), and each was
hardened with an adversarial multi-agent review plus a standalone logic test suite.

### Added

- **Evidence Gates.** When an Agent View-spawned agent settles, its worktree is
  verified automatically: the project's checks (`typecheck` / `lint` / `test` scripts,
  `tsc --noEmit`, cargo/go fallbacks — or your own `mas.evidence.commands`) run inside
  the worktree, and the result shows as a `checks ✓` / `checks 1/3 ✗` chip on the
  agent's row, in its tooltip, and as a pill in Review & Land. Details:
  - Auto-detected commands ask for a **one-time per-repo approval** before ever
    running (they are code from the worktree); explicitly configured commands don't.
  - **Staleness tracking** — evidence is fingerprinted against the worktree's commit
    and uncommitted content, so proof from before new edits shows as `checks stale`
    rather than passing for current work. Identical content is never re-verified
    (settles are cheap; npm runs are not).
  - The **land confirmation** now states the evidence verdict, and
    `mas.evidence.blockLandOnRed` turns missing/failing/stale evidence into a hard
    block. Reports persist to `.agentview/evidence/` and survive window reloads.
  - **Self-repair** (`mas.evidence.selfRepair`, off by default) — failing output is
    handed back to the agent's terminal to fix and re-verify, capped by
    `mas.evidence.maxRepairs`, then escalated to you.
  - New commands: **Run Evidence Checks** and **Show Evidence Report** (context menu
    on any managed agent row).
- **Live presence.** Explorer and tab badges (`AI`, blue) on files an agent is editing
  *right now*, driven by hook events; badges fade after 45 seconds of inactivity and
  clear when the session stops. `mas.presence.enabled` to turn off.
- **Fleet Shift Report.** One command (`Agent View: Fleet Shift Report`, also in the
  Agents toolbar menu) renders what the fleet did while you were away: a
  "waiting on you" list plus a per-agent table of status, plan, diff size, evidence
  verdict, tokens, and estimated cost. Turning **Unattended Fleet off** opens it
  automatically — auto-pilot ends with a briefing. An optional AI-written opening
  paragraph (`mas.shiftReport.aiNarrative`, off by default, consent-gated) sits on
  top of the always-available deterministic table.

### Changed

- **Review & Land** rows now carry an evidence pill (`checks running` / `checks n/m` /
  `checks stale`), and the review queue rebuild runs its per-agent git work
  concurrently — noticeably faster with many agents.
- **Pinboard is feature-frozen** while we evaluate its future — no removals, no new
  investment. The Teams cockpit will move to its own panel in a later release.

## [0.5.0] — 2026-06-30

Three headline features for working with a fleet of agents — **Review & Land**, the
**Teams cockpit**, and **Unattended Fleet** — plus a UI readability pass and a more
inviting Pinboard. Each feature was hardened with an adversarial multi-agent review.

### Changed

- **UI readability pass.** Loud, solid, ALL-CAPS status chips across the Detail panel and
  the Pinboard are now calm, natural-case tinted pills; transcript role labels are tinted
  per role and long tool output is capped + scrollable; the model/token/time meta wraps
  cleanly instead of truncating.
- **A more inviting Pinboard.** A pin icon and an empty-welcome link make it discoverable;
  the empty state leads with the value and a zero-cost tour; the dock self-documents with
  labels; a "Race"/"Fan-out" toast offers to open it; and after a race/fan-out you're
  nudged toward the spatial view. The Teams cockpit gains a switcher when several teams run.

### Added

- **Unattended Fleet (governed auto-pilot).** Toggle it from the Agents toolbar (or
  `Agent View: Toggle Unattended Fleet`). While on, Agent View-spawned agents run with
  guardrails:
  - **Safe auto-accept** — new agents spawn with `--permission-mode acceptEdits`, so file
    edits don't block, but **Bash and other tools still prompt** (which surfaces as
    "needs you" and a notification — a stray destructive command never runs unattended).
  - **Auto-nudge stalled agents** — an agent that goes idle mid-plan is nudged to keep
    going, capped at `mas.unattended.maxNudges`, then escalated to you if it stays stuck.
  - **Cost meter + budget** — Fleet Pulse shows a live estimated `~$X.XX` for the fleet,
    and a per-agent `mas.unattended.maxCostUsd` cap pauses an agent that exceeds it
    (its branch and diff are kept). Prices are configurable (`mas.unattended.pricing`).
- **Teams cockpit (Pinboard).** A new **Teams** mode on the Pinboard (toggle in the
  dock, badged with the teammate count) visualizes an active Agent-Teams-style run,
  live and read-only:
  - **Roster** of named teammates (from each session's subagent sidecars), with a
    `plan` badge for plan-approval teammates, plus live status, type, and tokens —
    click one to focus it.
  - **Task dependency graph** parsed from the lead's shared task list (its TodoWrite):
    a topological-layer DAG with dependency edges, `owner` badges, and a derived
    `blocked` state (waiting on an unfinished dependency).
  - **Workflow runs** (`subagents/workflows/wf_*`) shown as chips.
  - Native-store aware: if Claude Code's experimental Agent Teams store
    (`~/.claude/teams` / `~/.claude/tasks`) ever materializes, the cockpit detects it.
- **Review & Land.** A new **Review** tab (and the `Agent View: Review & Land` toolbar
  button) turns each spawned agent's work into a reviewable, landable unit:
  - **True diffs.** Every changed file opens as a native VS Code side-by-side diff
    against the agent's exact fork point — committed **and** uncommitted **and**
    untracked files (the old diff showed only committed work). Rows show a `+/−` stat,
    the agent's plan `done/total`, and a tests-red / uncommitted chip.
  - **Request changes.** Type feedback and it is sent to the agent's terminal and saved
    to `.agentview/review/<id>.json` (the same no-new-network-surface bridge as the
    Pinboard), so the agent can revise in place.
  - **Land it.** **Squash-merge** into your current branch — refused on a dirty/mid-merge
    tree, snapshots the agent's uncommitted work first so what you reviewed is what lands,
    and is reversible (Undo) until you push. Off by default behind `mas.review.allowLand`;
    **Open PR** (`gh pr create`, with a push-and-copy-compare-link fallback) and **Copy
    merge command** work regardless. Nothing is auto-merged and no branch is ever deleted.
  - New settings: `mas.review.allowLand`, `mas.review.maxDiffFiles`, `mas.review.ghPath`.

## [0.4.2] — 2026-06-29

### Fixed

- README feature list rendering — the embedded Pinboard image had no blank line
  after its `</p>`, so the HTML block swallowed the rest of the list and the
  remaining features collapsed into one paragraph on the Marketplace/Open VSX
  listing. No functional changes.

## [0.4.1] — 2026-06-29

### Changed

- Docs/listing refresh only — no functional changes. The promo GIF is re-rendered
  at a higher resolution (and now includes a Pinboard scene), and a dedicated
  Pinboard GIF was added, so the Marketplace/Open VSX listing shows the sharper,
  current walkthrough.

## [0.4.0] — 2026-06-29

### Added

- **Live plan progress.** When an agent keeps a `TodoWrite` to-do list, its own plan is
  now surfaced as a `4/7 · <current step>` chip in the Agents tree, the Detail view, and
  the Pinboard — the agent's ground-truth "now doing X", parsed from the transcript with
  no extra LLM calls. The ambient action line shows `Plan 4/7 · …` instead of a constant
  "Updating the plan".
- **Failure detection (no LLM).** When an agent's most recent tool ends in failure
  (a non-zero `Bash` exit, a tool error), it surfaces a precise reason
  (`Bash failed: <first stderr line>`) on the tree, the Detail view, and the Attention
  Router, and promotes the agent to the `error` state if it then goes quiet. Read straight
  from the session transcript, so it works for externally-launched agents too.
- **Fleet Pulse.** A one-line status-bar heartbeat (`2 running · 1 needs you · 3 idle`)
  that stays visible even when the Agent View panel is closed, turns the warning color the
  moment any agent needs you, and jumps to that agent on click. Toggle with the new
  `mas.statusBar.enabled` setting.
- **Dismiss "needs you".** A stuck `waiting`/`error` agent can now be manually dismissed —
  inline in the tree, a "Dismiss all" status-bar button, or per-row in the inbox. A
  dismissed agent reads as plain **idle**, and **resurfaces automatically the moment it
  does something new** (or on a fresh hook-driven prompt), so a real ask is never lost.

## [0.3.0] — 2026-06-25

### Added

- **Pinboard — an infinite canvas for your agents.** Open it from the Agents toolbar.
  Every agent is a live card you can arrange on a pan/zoom canvas:
  - **Pin** a diff (for spawned worktree agents) or an external agent's latest output as a
    durable card, saved into `.agentview/board/` so the board is git-committable and travels
    with the branch. Add notes, link cards with labelled arrows (selecting one linked card
    selects the whole connected group), and expand an agent's subagents as tethered cards.
  - **Send a selection back to an agent** — the agent reads `.agentview/board/selection.json`
    and can post results onto the board by writing `.agentview/board/inbox/<id>.json`. No new
    network surface; the bridge is files the extension watches.
  - A **Figma-style floating toolbar** — a bottom-center dock plus a contextual selection bar.
- **A distinct `thinking` status.** A long reasoning phase, or a parent delegating to active
  subagents, now shows **thinking** (instead of flipping to idle) across the tree, the Detail
  view, and the Pinboard; parents show how many subagents are working.
- **Recency window.** A `mas.recentHours` display window (default 24h) hides older idle agents
  behind a one-click "Show older (N)" toggle in the tree and Pinboard. Active agents always
  show; the 7-day discovery bound (`mas.recentDays`) is unchanged. External transcripts are
  only hidden, never deleted.

### Changed

- Removed emoji throughout the UI in favour of clean text and inline icons.

## [0.2.5] — 2026-06-23

### Added

- **The agent's thinking phase is now visible in the Detail transcript.** While an agent
  is reasoning, a live "💭 Thinking…" marker shows at the bottom of the transcript and is
  replaced by its reply or tool call the moment it acts. When a model records its thinking
  text (extended-thinking turns), the thinking is shown inline and dimmed. Most recent
  models persist thinking as signature-only, so those turns show just the live marker —
  previously the view appeared frozen while the agent thought.
- **Agent-consumable repository docs** — `AGENTS.md` (build/verify commands, project
  layout, conventions, gotchas for AI coding agents) and `llms.txt` (an llmstxt.org index
  of the docs and key source files). Both are excluded from the packaged extension.

## [0.2.4] — 2026-06-22

### Fixed

- **Agent titles now summarise the task instead of echoing the first sentence.** Claude
  Code already generates a short, self-updating title for each session, but the extension
  read the wrong transcript field and always fell back to the opening prompt. It now uses
  Claude's native title and keeps it fresh as the conversation's focus shifts. Sessions
  Claude hasn't titled yet still fall back to the first prompt.

### Changed

- Agents you spawn (race / fan-out / New Agent) now adopt Claude's evolving title once it
  exists, rather than staying pinned to the prompt you launched them with. Race contenders
  keep their `Race N ·` prefix so same-prompt agents remain distinguishable.

## [0.2.3] — 2026-06-22

### Changed

- Docs only: the extension is now published on the **VS Code Marketplace** in addition
  to Open VSX, and the Install section reflects that (VS Code users can install directly
  instead of sideloading a `.vsix`). No functional changes — this release exists to
  refresh the README shown on the marketplace listing pages.

## [0.2.2] — 2026-06-22

### Changed

- Removed the redundant `＋` (New Agent) and `⟳` (Refresh) buttons from the Detail
  panel header — they duplicated the Agents toolbar. The Detail/Race/Fan-out tabs,
  which are unique to this panel, stay.

## [0.2.1] — 2026-06-22

### Fixed

- Actually removed the detail-view "NOW" box. 0.2.0 documented this, but the box was
  still rendered (it echoed the agent's last message under a "NOW" label); it is now
  gone from the markup and styles. The live "now doing X" overview remains the intended
  replacement.

## [0.2.0] — 2026-06-22

Three headline features for working with a fleet of agents, plus hardening from a
multi-dimension review.

### Added

- **Notifications** — a toast (and optional chime) when an agent needs your input,
  finishes, or hits an error. Subagents are excluded to avoid bursts, and "finished"
  fires at most once per agent so interactive sessions don't ping every turn.
  Configurable: `mas.notifications.enabled` / `.sound` / `.onWaiting` / `.onDone` /
  `.onError`.
- **Ambient "now doing X"** — every agent shows a live one-liner of its current action
  ("Editing auth.ts", "Running: npm test", "Searching: …"), derived from hook tool
  events with no extra LLM calls. Shown in the Agents tree and the detail panel.
- **🏁 Agent Race (best-of-N)** — spawn N agents on the same prompt, each in its own
  worktree, and compare them in a new **Race** tab: live per-contender status/tokens,
  **Open all diffs** (side-by-side columns), an optional **Rank with AI** pass (reuses
  Merge Advisor), and **Pick winner** — which opens the winner's diff and copies its
  `git merge <branch>` command. Nothing is merged or deleted automatically. Commands:
  `Agent View: Race Agents`, `Agent View: Clean Up Race/Fan-out Worktrees`. Config:
  `mas.race.defaultCount`.
- **Fan-out** — paste a checklist into the **Fan-out** tab, or select lines in any file
  and run `Agent View: Fan-out Selection to Agents`, to spawn one worktree-agent per
  task. Capped at `mas.fanout.maxConcurrent` (default 4) so remaining tasks queue and
  start as earlier agents finish. Config: `mas.fanout.maxConcurrent`, `mas.fanout.useWorktree`.

### Changed

- Removed the detail-view "NOW" box that merely echoed the last message; its intent is
  now served by the live "now doing X" overview.
- `lastAction` phrasing is humanized ("Editing X" instead of raw `Edit <path>`) and kept
  brief.
- Worktree diffs now use the exact fork-point commit captured at spawn, so they stay
  correct even if you switch the repo's branch afterwards.

### Fixed

- **Windows**: task prompts were quoted with POSIX single-quote escaping and corrupted
  under PowerShell/cmd; quoting is now platform-aware. Extra spawn flags are quoted too.
- Terminal hook statuses (idle/done/error) could pin a session's status forever; they
  now age out and yield to newer transcript activity.
- The Race tab no longer strands you on an empty surface if its agents are removed
  elsewhere.
- The fan-out draft is no longer lost when switching view tabs.
- Bounded growth of internal status/notification tracking maps; assorted error-handling,
  cleanup-on-failure, and accessibility fixes.

## [0.1.3] — 2026-06-18

- Fix: show the full message in the detail "NOW" box.

## [0.1.2] — 2026-06-18

- Initial release: Agents panel, worktree spawning, live status, React detail view, and
  the opt-in AI helpers (Conflict Radar, Attention Router, Merge Advisor).
