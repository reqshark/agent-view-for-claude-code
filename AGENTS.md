# AGENTS.md

Operational guide for AI coding agents working in this repository. Human-facing
overview, features, and screenshots live in [README.md](README.md); this file is the
"how to work here" companion. Keep both accurate when you change behavior.

## What this is

A VS Code extension — **Agent View for Claude Code** — that discovers, spawns,
orchestrates, and monitors multiple Claude Code agents (each in its own git worktree)
from one panel. It is **two packages in one repo**:

- **Extension host** — `src/**` (TypeScript), bundled by **esbuild** → `dist/extension.js`.
  Runs in Node inside VS Code; `vscode` is an external provided by the runtime.
- **Webview UI** — `webview-ui/**` (React + **Vite**) → `webview-ui/dist/`. Runs in the
  Detail panel's sandboxed webview. It has **no access to `vscode`** — it talks to the
  host only through `postMessage` (see the protocol files below).

## Setup & commands

```bash
npm install                  # root deps (host: @types/node, @types/vscode, esbuild, typescript)
npm run build                # FULL build: webview (Vite) THEN extension host (esbuild)
npm run watch                # esbuild watch — iterate on the host only
npm run typecheck            # host:    tsc --noEmit   (uses ./tsconfig.json, src only)
cd webview-ui && npm run typecheck   # webview: tsc --noEmit (strict, noUnusedLocals)
cd webview-ui && npm run build       # webview only (Vite)
cd webview-ui && npm run dev         # Vite dev server (rarely needed; F5 is the usual loop)
```

- `npm run build:webview` runs `npm install` inside `webview-ui/` first, so the webview has
  its own `node_modules`. After a fresh clone, run the full `npm run build` once.
- To run the extension: open the repo in VS Code and press **F5** (Extension Development
  Host). The Detail panel renders a placeholder until `webview-ui/dist/` exists, so
  **build the webview before launching**.

### Verifying a change (do this before claiming done)

There is **no automated unit-test suite**. The verification gates are:

1. `npm run typecheck` (host) — must be clean.
2. `cd webview-ui && npm run typecheck` — must be clean.
3. `npm run build` — must succeed (this is also `vscode:prepublish`).

`scripts/smoke.ts` is a *manual* data-layer sanity check (discovers your real sessions and
prints a few transcript messages). Note its header one-liner
(`esbuild --bundle … scripts/smoke.ts | node`) currently **fails standalone**, because
`src/util/format.ts` imports `vscode` and it gets pulled transitively. If you must run it,
alias `vscode` to a stub during bundling. Prefer the typecheck + build gates above.

## Where things live

```
src/                       extension host
  extension.ts             activation; wires commands, tree, webview, hooks
  store.ts                 AgentStore: discovers + fs.watch(~/.claude/projects and
                           ~/.claude/sessions), heartbeat refresh, onDidChange; merges
                           registry + hook status, holds liveAction
  discovery.ts             find Claude Code sessions on disk
  sessionRegistry.ts       read Claude Code's live session registry (~/.claude/sessions)
  usage.ts                 incremental whole-file usage scan (each API message once)
  pricing.ts               model list prices + cost of billed usage (matches /cost)
  transcript.ts            parse session JSONL -> status/tokens/label/lastAction;
                           readMessages() flattens to displayable transcript messages;
                           readEventStrip() builds the Scroll (one char per event)
  board/                   the Session Board: materialize.ts (transcript -> episodes/
                           plans/commits/evidence, no LLM), panel.ts (editor-area
                           WebviewPanel), types.ts (protocol + legacy on-disk shapes),
                           store.ts (.agentview/board/ selection + inbox bridge)
  subagents.ts             discover child subagents of a session
  teams/discover.ts        Agent Teams: teammate sidecars, native store readers
                           (~/.claude/teams + ~/.claude/tasks, READ-ONLY), mailbox
                           message accumulator, team snapshot for the cockpit
  triage/                  the Triage inbox: types.ts (domain + protocol),
                           text.ts (rules normalize + lexical similarity, PURE),
                           judge.ts (Claude adjudicates "same question?" and
                           "does this decision answer it?"; text.ts shortlists),
                           intake.ts (questions from hooks/transcript/conflicts),
                           engine.ts (normalize -> dedup -> lookup -> route,
                           auto-answer policy, circuit breaker), store.ts
                           (decision log + metrics; NOT repo-local by default),
                           hold.ts (parked blocking-hook responses),
                           panel.ts (host side of the mas.triage webview)
  types.ts                 shared domain types (AgentSession, AgentStatus, TokenUsage)
  paths.ts                 ~/.claude path helpers
  tree/agentsProvider.ts   native TreeDataProvider for the Agents view (mas.agents)
  webview/provider.ts      DetailViewProvider — host side of the Detail webview (mas.detail)
  webview/protocol.ts      host<->webview message types  (SEE "manual sync" below)
  hooks/server.ts          local HTTP server receiving Claude Code hook events (push
                           status) on /mas-hook, plus Triage's /mas-triage channel that
                           HOLDS its response open until a human answers
  hooks/installer.ts       install/remove hooks in ~/.claude/settings.json
  orchestrator/            worktree.ts, spawn.ts, groups.ts, registry.ts, terminals.ts,
                           version.ts (CLI version probe gating newer spawn flags),
                           naming.ts (the --name MAS spawns with)
                           — spawn managed agents in git worktrees; Agent Race; Fan-out
  features/                router.ts (Attention Router), mergeAdvisor.ts, conflicts.ts
                           (Conflict Radar), notifications.ts, insights.ts, consent.ts,
                           unattended.ts (auto-pilot), evidence.ts (Evidence Gates),
                           presence.ts (live file badges), shiftReport.ts (fleet digest)
  llm/runner.ts            invoke `claude -p` for the opt-in AI helpers
  util/                    markdown.ts (stripMarkdown), format.ts (humanizeTool, statusIcon),
                           checklist.ts, planTracker.ts (TodoWrite + Task-tool plans)
webview-ui/src/            React Detail UI
  App.tsx                  Detail panel: fleet header, Scroll minimap, transcript,
                           "Needs you" inbox
  RaceView.tsx             Agent Race tab        FanoutView.tsx  Fan-out tab
  Strip.tsx                the Scroll (shared by Detail + board entries)
  protocol.ts              message types  (MIRROR of src/webview/protocol.ts)
  ui.tsx                   shared presentational helpers   vscodeApi.ts  postMessage bridge
  board/                   Session Board entry: BoardApp.tsx (fleet list + frame),
                           SessionBoard.tsx (lanes x episodes), TeamsCockpit.tsx,
                           protocol.ts (MIRROR of src/board/types.ts + materialize shapes)
  triage/                  Triage entry: TriageApp.tsx (Inbox / Auto / Decisions tabs),
                           protocol.ts (MIRROR of the protocol half of
                           src/triage/types.ts), api.ts, triage.css
```

### The three sidebar views

`package.json` contributes **mas.agents** (tree), **mas.triage** (webview), and
**mas.detail** (webview) in that order, each with `"initialSize": 1`. Triage is
**opt-in** (`mas.triage.enabled` defaults off since 0.10) and its view carries
`"visibility": "collapsed"`, so a fresh install opens as Agents over Detail with a
collapsed Triage header between them; turned on, it is an equal third. `visibility`
only applies on first install — VS Code remembers the layout after that. Adding or
reordering a view here changes that layout — keep the sizes equal unless you mean to
change it. While off, the Triage webview renders its pitch and a **Turn on Triage**
button (`{type:"enable"}`), and every engine entry point returns before recording
anything.

`webview-ui/` has **three** Vite HTML entry points — `index.html` (Detail),
`triage.html` (Triage), `board.html` (Session Board). A new panel needs an entry in
`vite.config.ts` as well as its own `.html`.

### Data sources (fidelity order)

1. **Claude Code hooks** (push, low-latency) — POST to `hooks/server.ts`. When present,
   status is authoritative (`statusSource: "hook"` beats `"jsonl"`).
2. **Claude Code's live session registry** (zero-config, read-only) —
   `~/.claude/sessions/<pid>.json`, one per running process (what `claude agents` and
   ListAgents read). Observed shape (2.1.289): `{ pid, sessionId, cwd, kind, entrypoint,
   pidDomain, name, nameSource, status: busy|idle|waiting, waitingFor?, updatedAt,
   statusUpdatedAt, … }`. Gives `statusSource: "registry"`; against a hook status the more
   recently changed one wins. Entries outlive crashed processes: when `pidDomain` is
   ours, the pid must be alive **and** its OS start time must equal `procStart` (pids
   are reused); otherwise require freshness. **Never open the `<pid>.<hash>.key`
   files beside them** — they hold peer tokens.
3. **Session JSONL transcripts** (pull/replay, zero-config fallback) —
   `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`, plus
   `<session-id>/subagents/**/agent-*.jsonl`. Besides turns, Claude Code re-appends
   metadata lines as they change (newest wins): `ai-title`, `custom-title` (a `/rename`
   **or** `--name` — MAS filters its own spawn name), `agent-name`, `pr-link`,
   `permission-mode`, `cost-state` (per *process*, not per session — don't use it as a
   session total). `isCompactSummary` user lines are compaction recaps, not prompts.
4. **Triage's Hold channel** (blocking, opt-in) — with `mas.triage.hold.enabled`, a
   second `PreToolUse` hook matched to `AskUserQuestion` POSTs to `/mas-triage` and
   **keeps its stdout**; the server holds the response until a human answers, then
   replies with `{hookSpecificOutput:{permissionDecision:"deny",permissionDecisionReason:
   <answer>}}`, which Claude Code feeds to the model as the tool result. **Every failure
   path must print nothing and exit 0** (no server, port taken, hold expired) — that is a
   no-op hook and Claude Code prompts as usual. Never make a hold unbounded: the hook
   entry carries an explicit `timeout` (seconds) and the curl an `-m` just under it.
5. **Native Agent Teams store** (experimental, shifts often) —
   `~/.claude/teams/<team>/` (config.json roster when present, `inboxes/*.json`
   mailboxes) and `~/.claude/tasks/<team>/*.json` (shared task list). Read by
   `src/teams/discover.ts` only, defensively, and **never written** — Claude Code
   owns and rewrites these files. Observed mailbox entry shape (2.1.196):
   `{ from, text, timestamp, msgV, msg_id, type, read }`, where `text` may be
   JSON for protocol traffic (e.g. `shutdown_request`). On 2.1.289 teams are named
   `session-<lead id prefix>` and `config.json` is camelCase (`leadSessionId`,
   `members[].agentId/agentType/backendType`).

## Conventions you must follow

- **Protocol files are kept in MANUAL sync** — `src/webview/protocol.ts` mirrors
  `webview-ui/src/protocol.ts` (Detail panel), `src/board/types.ts` +
  `src/board/materialize.ts` shapes mirror `webview-ui/src/board/protocol.ts`
  (Session Board), and the protocol half of `src/triage/types.ts` (everything below the
  `// --- protocol --` banner) mirrors `webview-ui/src/triage/protocol.ts` (Triage).
  They live under separate tsconfig roots, so there is no shared import. **Any change to
  a message shape (`ExtToWeb` / `WebToExt` / `ExtToBoard` / `BoardToExt` / `ExtToTriage`
  / `TriageToExt` / `TranscriptMessage` / `SessionBoardData` / `TriageState` / …) must be
  edited in BOTH places**, or the panel silently breaks at runtime.
- **`vscode` is host-only and external.** Never import it from `webview-ui/**`, and avoid
  pulling it into modules you want to run outside the host. The webview communicates only
  via `postMessage` through `vscodeApi.ts`.
- **Transcript shape gotcha:** Claude Code writes one assistant message as *multiple JSONL
  lines, one per content block*, all sharing `message.id` (order: `thinking` → `text` →
  `tool_use`). Recent models persist thinking as signature-only (empty `thinking` text).
  Parsing code must not assume one line == one turn. Every line of a message repeats the
  **same `usage`** — count it once per `message.id` (see `src/usage.ts`).
  See `src/transcript.ts`.
- **Plans:** current models get `TaskCreate`/`TaskUpdate` (only with
  `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`), older ones `TodoWrite`. Read plans through
  `util/planTracker.ts`, never by matching `TodoWrite` alone, and over the whole file
  (`usage.ts` does it incrementally) — Task-tool plans are built one call at a time.
- **Notifications about other sessions:** `agent_needs_input` / `agent_completed` come
  from the fleet view and carry *its* session id, not the job's. Never map them to a
  status; the registry has the job's own state.
- **Namespacing:** the activity-bar container, all commands, and all settings use the
  `mas` / `mas.*` prefix (e.g. `mas.agents`, `mas.detail`, `mas.newAgent`,
  `mas.notifications.enabled`). Register new commands/settings in `package.json`
  `contributes` and wire them in `extension.ts`.
- **Webview HTML uses a strict CSP with a per-load nonce** (`webview/provider.ts`). Don't
  add inline scripts or external resource loads that the CSP would block.
- **Style:** TypeScript `strict`, 2-space indent, named exports, double quotes. Add a terse
  "why" JSDoc above exported symbols; prefer explaining intent over restating code. Match
  the surrounding file.

## Safety / things that touch the user's machine

- The **orchestrator** spawns real `claude` processes, creates **git worktrees + branches**,
  and opens terminals. Spawn/stop/cleanup operations mutate the user's filesystem and git
  state — read the surrounding code and be conservative. Race/Fan-out never auto-merge or
  auto-delete; keep it that way.
- The **AI helpers** (Attention Router, Merge Advisor, Conflict Radar) are **off by default
  and consent-gated**, and call `claude -p` (consumes the user's Claude subscription). Keep
  them opt-in. **Triage is the one exception**: `mas.triage.ai.enabled` defaults **on**,
  because judging "are these the same question?" is the whole feature and word overlap
  cannot do it. Triage itself is opt-in (off until the user turns it on), and its AI is
  still behind the same one-time consent modal, so nothing runs until the user agrees; it
  degrades to `text.ts`'s lexical matching when off, declined, or unreachable — every AI
  path in `engine.ts` has that fallback and must keep it.
- **Helpers judge text; they never act.** `llm/runner.ts` runs every `claude -p` with no
  tools, no MCP servers or skills and no session file. Their prompts carry untrusted
  transcript text, and print mode can default to auto mode (2.1.285+), so a helper with
  tools is a prompt-injection path into the user's workspace. Put what a helper needs
  in its prompt instead of giving it tools.
- **The model judges content; the engine judges scope.** `scopeCovers()` (repo / branch /
  pathGlob / session), expiry and revocation are hard deterministic filters applied
  *before* any call, and the prompts are deliberately not told the scope — handing it over
  just invites the model to re-litigate a check that already passed, which it gets wrong.
  Keep that split.
- **A question can be answered outside Triage, and usually is.** The human often walks
  over to the session and answers in its terminal. `engine.captureAnswer()` reads that
  answer back off the transcript (`toolUseResult.answers`) as the row is pruned, so the
  Decision Log still learns from it; `dispatchAll()` skips any session that is no longer
  `waiting`, so a late answer never lands in a session that moved on. Anything that
  changes cluster pruning must keep both.
- **Triage answers on the human's behalf.** Keep every guard that makes that safe: a
  `permission` question only ever reuses a decision the human made on a permission
  question, `conflict` questions are never auto-answered, an auto-answer always leaves a
  revocable record, and the error-rate breaker demotes auto-answer to dry run on its own.
  Widening any of these is a product decision, not a refactor.
- **Don't write into the user's repo.** Triage keeps its state in VS Code's private
  per-workspace storage by default (`context.storageUri`); `mas.triage.storage: "repo"`
  is an opt-in for teams who want the decision log committed. Metrics are never
  repo-local. Any new persistent state should follow the same rule — a panel that makes
  people add a `.gitignore` line has taken something that isn't its.
- **`~/.claude/settings.json` belongs to the user.** Triage's Hold hook lives there, so
  flipping `mas.triage.hold.enabled` only *offers* to rewrite the hooks — it must never
  write there unprompted. `installHooks` still backs the file up before its first
  mutation, and `removeHooks` still leaves non-MAS hooks alone.

## Commits, PRs, releases

- Branch off and PR against **`main`**.
- Commit style observed in history: a conventional-ish prefix — `docs: …`, `Fix: …`, and
  for releases `Release vX.Y.Z: <one-line summary>`.
- **Release flow:** bump `version` in `package.json`, add a `CHANGELOG.md` entry,
  `npm run build`, then package/publish. Open VSX is the primary registry; the VS Code
  Marketplace listing is updated manually. Don't commit tokens.
