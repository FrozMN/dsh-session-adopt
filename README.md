# dsh-session-adopt

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that finds sessions created **outside the running desktop window** — for example by an IDE's ACP client — and adopts them into their matching Workspace.

It also adds a **Sync sessions** action to the sidebar footer and refreshes the browser's session catalog, so new sessions appear without restarting the Harness.

On top of that it can **detect sessions from other local agent harnesses** — starting with [pi](https://github.com/badlogic/pi-mono) — and **import them as native DSH sessions**, filed into the Workspace matching their working directory. The **Import sessions** sidebar action opens a picker; the same work is available through same-origin JSON routes for scripts.

```
Sidebar
  ...
  ⚙  Settings
  ⟳  Sync sessions   +3
  ⬇  Import sessions
```

## Why this exists

DeepSeek Harness persists sessions in a store shared by every client and process. A running Web/Desktop Host, however, builds its `cwd → Workspace` index once at startup, and the browser's session list never re-reads itself.

A session created by another process — VS Code through ACP, an SDK client, a headless run — is therefore written to disk but stays **ungrouped**; it only appears after restarting the Harness, and even then it may not be attached to its Workspace.

This plugin closes that gap at runtime:

1. List durable sessions through `ctx.sessionPersistence`.
2. Resolve each session's `cwd` to a canonical path and match it to a Workspace.
3. Attach the session with `workspace.attachSession()`.
4. Let the existing `workspace.follow` stream update the sidebar.
5. Refresh the client catalog with `ctx.sessions.refresh()` so the rows are visible immediately.

## Features

- **Manual sync** from the sidebar footer; the button reports its last result and a `+N` badge.
- **Startup scan** so sessions that already exist when the plugin loads are attached.
- **Scheduled scan** every 2 hours by default, limited to active workspaces.
- **Active window** of 6 hours, measured from the session log's modification time. A newly discovered
  session makes its directory active even when no Workspace exists for it yet.
- **Focus scan** when the window becomes visible again (at most once per minute), which covers the
  usual “switch back from the IDE” flow.
- **Automatic Workspace creation** for new sessions whose canonical `cwd` has no registration.
- **Idempotent, serialized scans**; failures are reported per session instead of aborting the scan.
- **Cross-harness detection** of foreign session stores (`pi` and `VS Code Copilot` shipped, adapter slots for Claude Code, Codex, Gemini CLI and OpenCode). Foreign stores are only ever read.
- **Import dialog** in the sidebar footer: a window listing detected sessions with harness badge, title, cwd, message count, model and target Workspace; select several and import in one click, with per-row outcomes and English/Chinese copy.
- **Native session synthesis**: the foreign conversation is converted into a validated DSH v4 durable session (turns, steps, tool calls/results, title) without calling a model during the import.
- **Workspace creation and attachment**: imports land in the Workspace matching the session's canonical `cwd`; a missing Workspace is created on explicit import.
- **Idempotent imports**: deterministic session ids mean re-importing the same foreign session reports “already imported” instead of creating a duplicate.
- **Scriptable API**: auth-fenced `/session-import/*` routes back the dialog and can be driven by local tooling.
- **English and Chinese UI**, following the Harness locale.

## Requirements

- A DeepSeek Harness Web or Desktop profile that mounts the Workspace plugin and the Web sidebar.
- Session persistence (the shipped JSONL backend is fine).
- No npm dependencies; the plugin only uses Node built-ins and the Harness services listed in
  [`index.js`](index.js) (`webServer`, `connection`, `sessionPersistence`, `workspaceRegistry`, `sessions`).
- For cross-harness import: a readable foreign session store on the same machine. The shipped adapters
  support pi (`~/.pi/agent/sessions`, or the `PI_CODING_AGENT_SESSION_DIR` /
  `PI_CODING_AGENT_DIR` overrides) and GitHub Copilot Chat in VS Code (the VS Code `workspaceStorage`
  chat stores, or the `COPILOT_USER_DATA_DIR` / `VSCODE_USER_DATA_DIR` overrides). Other harnesses need
  an adapter module under [`import/adapters/`](import/adapters/).

## Install

### From the Plugins page (recommended)

1. Clone this repository to a directory on the Harness host, or keep the repository URL.
2. Open **Settings → Plugins** in DeepSeek Harness.
3. Use **Install bundle** and point it at the local directory or the repository URL.
4. Enable **Session adopt** if it is not enabled automatically.

The install step must perform both package installation and **bundle selection**. The Plugins page
does that; a raw `pnpm add` inside a profile does not.

### With the plugin manager tool

If the current agent exposes the Host `plugin_manager` tool, install the bundle with:

```text
plugin_manager install_bundle  <absolute-path-or-git-url>
```

Then verify that the `session-adopt` row is active:

```text
plugin_manager list_plugins
```

### With the dsh CLI

The package declares a `dsh.bundle` manifest, so the profile package manager can install and select it
in one command:

```sh
dsh plugin --profile web add https://github.com/FrozMN/dsh-session-adopt
```

Restart the profile (or the desktop app) afterwards to load the new bundle. The same command takes a
local checkout for development, for example
`dsh plugin --profile web add /absolute/path/to/dsh-session-adopt`. A directory install is linked into
the profile, so later edits only need the plugin to be reloaded.

### Updating

Replace the package files (or pull the repository), then restart the plugin from the Plugins page.
Because the package is a plain ESM bundle with no build step, no compilation is required.

## Usage

| Action | Result |
|---|---|
| Click **Sync sessions** | Full scan, including older ungrouped sessions, then refresh the session list |
| Hover the button | Last sync time, number of sessions placed, or the failure reason |
| `+N` badge | Sessions placed by the latest sync |

The button is registered in the `sidebar.footer.action` slot, beside the Settings entry. It is
visible in both the expanded sidebar and the collapsed rail.

## Cross-harness session import

### From the sidebar

1. Click **Import sessions** (second footer action, below **Sync sessions**).
2. The dialog lists every detected foreign session, grouped by harness. Rows show the harness badge, the
   session title, its working directory, message count, model and the Workspace it will land in
   (`→ existing workspace`, or `→ new workspace: /path`).
3. Select one or more rows (or **Select all**), then **Import selected**.
4. Each row reports its outcome: imported (with the new DSH session id and Workspace), already imported,
   or the failure reason. The session catalog is refreshed, and the Workspace snapshot follows the
   Harness `workspace.follow` stream, so new rows appear without a page reload.

Sessions that are already imported are skipped by identity, not by title, so running the import twice
never duplicates a conversation.

### From scripts and other tools

All routes sit behind the same Host/Origin fence and browser-session cookie as the rest of the Harness,
accept `application/json`, and never accept a filesystem path (selections are opaque keys returned by a
scan):

| Route | Method | Purpose |
|---|---|---|
| `/session-import/sources` | `GET` | Adapter inventory: id, title, availability, roots |
| `/session-import/scan` | `POST` | Scan foreign stores; body `{}` or `{ "adapterIds": ["pi"] }` |
| `/session-import/import` | `POST` | Import selected candidates; body `{ "selections": ["<candidateKey>", …], "workspace": "auto" }` |
| `/session-import/status` | `GET` | Config, in-flight flags, last scan and last import summaries |

`workspace` may also be `{ "kind": "existing", "workspaceId": "…" }` or `{ "kind": "new", "cwd": "/abs/path" }`;
the default `"auto"` matches an existing Workspace by canonical `cwd` and creates one when needed. A
request is a single selection batch, returns HTTP 200 with per-selection `imported` / `skipped` /
`errors` arrays, and is serialized inside the Host process.

### Adapters

An adapter is a dependency-free ESM module under [`import/adapters/`](import/adapters/) exporting
`id`, `title`, `available(ctx)`, `listSessions(ctx)` and `readSession(ctx, key)`. `listSessions` returns
metadata only (a scan never reads conversation content); `readSession` returns a normalized transcript
(`user` / `assistant` / `tool` messages with `text`, `reasoning` and `tool-call` blocks) that the Host
converts into the native session log. Images are imported as `[image]` placeholders in this version.
Additional adapters can be dropped in without touching the Host.

Two adapters ship today:

- **`pi`** — pi session format v1–v3, including branch selection (active leaf), usage tokens and tool
  results. Store: `~/.pi/agent/sessions` (`PI_CODING_AGENT_SESSION_DIR`, `PI_CODING_AGENT_DIR`,
  `PI_HOME`).
- **`copilot`** — GitHub Copilot Chat sessions stored by VS Code. Store:
  `<user data>/User/workspaceStorage/<workspace id>/chatSessions/`, plus the folder-less
  `globalStorage/emptyWindowChatSessions`. The working directory of a session is the folder recorded in
  that workspace's `workspace.json`, so imported Copilot sessions land in the same Workspace you had open
  in VS Code. Both on-disk forms are read: the append-only `.jsonl` operation log used since
  microsoft/vscode#286644 (VS Code ~1.109 / Insiders) — replayed with VS Code's own `kind 0/1/2/3`
  semantics — and the legacy single-file `.json`. Prose, reasoning, tool invocations with their recorded
  results (structured output or captured terminal output) and answered question carousels are converted;
  progress markers, code-block URIs and undo stops are dropped. VS Code variants (`Code`, `Code -
  Insiders`, `VSCodium`, `Code - OSS`) are discovered automatically, and `COPILOT_USER_DATA_DIR` /
  `VSCODE_USER_DATA_DIR` can name a user-data directory explicitly (path-delimiter separated for
  several).

## Configuration

The defaults are declared in the bundle's [`cordis.patch.yml`](cordis.patch.yml). To change them,
override the `session-adopt` row in the **profile's** `cordis.patch.yml`:

```yaml
- id: session-adopt
  name: "dsh-session-adopt"
  config:
    pollIntervalMs: 7200000
    activeWindowMs: 21600000
    autoCreateWorkspaces: true
    includeSubagents: false
    startupScan: true
    startupDelayMs: 2500
    importEnabled: true
    maxMessages: 4000
    maxCandidates: 500
```

The row's `config` is replaced wholesale, so restate every key you need.

| Key | Default | Meaning |
|---|---|---|
| `pollIntervalMs` | `7200000` (2 h) | Interval between active-workspace scans; minimum 1 minute |
| `activeWindowMs` | `21600000` (6 h) | How recently a session log must have changed for its workspace to be active |
| `autoCreateWorkspaces` | `true` | Create a Workspace when a new session's canonical `cwd` has none |
| `includeSubagents` | `false` | Also file `origin: "subagent"` sessions into Workspaces (not recommended) |
| `startupScan` | `true` | Run one full scan after the plugin mounts |
| `startupDelayMs` | `2500` | Delay before that startup scan |
| `importEnabled` | `true` | Mount the cross-harness import routes and the sidebar dialog |
| `maxMessages` | `4000` | Upper bound on normalized messages one imported session may carry; larger sessions are rejected with a clear per-selection error |
| `maxCandidates` | `500` | Upper bound on candidates returned to the dialog per scan (the host cache keeps them all) |

Changes restart the plugin, which also re-arms the timers and the startup scan. The import routes are
exact paths on the Host web server, so their names do not change with the loader row id.

## How it works

### Host half

- [`index.js`](index.js) implements `apply(ctx, config)`.
- It scans `ctx.sessionPersistence.list()`; each snapshot carries the session header and the log's
  location.
- `cwd` is canonicalized with `fs.realpath`; only existing directories are considered.
- Existing Workspaces are matched by canonical path. A missing one is created with
  `ctx.workspaceRegistry.create(path)` when policy allows.
- Sessions are attached oldest-first so the newest ends up first in the Workspace's order.
- The scan is serialized and reports `attachedCount`, `createdCount`, `deferredCount`,
  `skipCounts`, and bounded error details.

Two exact HTTP routes are registered behind the composition's trust fence
(`ctx.connection.requestRejection(req)` — Host/Origin validation plus the browser login cookie):

| Route | Method | Purpose |
|---|---|---|
| `/session-adopt/scan` | `POST` | Run a scan; body `{ "scope": "all" \| "active" }` |
| `/session-adopt/status` | `GET` | Read config, `scanning`, next scheduled time, and the last scan summary |

Request bodies are capped at 16 KiB and must be `application/json`. No request field is used as a
filesystem path.

### Client half

- [`client.js`](client.js) is a lazy browser module that registers the sidebar action.
- It calls the Host route, then `ctx.sessions.refresh()` to re-read the session catalog.
- It watches the Workspace snapshot delivered by `workspace.follow`. When a Workspace names a
  session the catalog does not know yet — the signature of a background scan — it refreshes the
  catalog once with a short loop guard.
- All visible text is registered in an `en` / `zh` dictionary through `ctx.locale`.

### Import half

1. **Detect** — each adapter reports its roots and lists candidate sessions with metadata only
   (header line + file stats; a scan never reads message content). The Host normalizes the candidates,
   canonicalizes their `cwd`, matches existing Workspaces and caches everything by an opaque key.
2. **Select** — the dialog posts opaque candidate keys back. The import route resolves them from that
   cache; request bodies never contain filesystem paths.
3. **Convert** — `import/events.js` synthesizes a v4 event log from the normalized transcript: one turn
   per user message, one step per assistant response, `tool/call` + `tool/result` pairs, a protected
   empty `system/message` surface head (needed before the session can ever be resumed), a `session/title`
   event, and a `TOOL_OUTCOME_UNKNOWN` repair result for advertised tool calls whose foreign result never
   arrived.
4. **Validate before writing** — the candidate log is run through the installed `Session` restore path
   (`ctx.sessions.prepare()` with the generated seed), so a conversion that the running Harness would
   refuse never reaches disk.
5. **Persist** — the log is written through `ctx.sessionPersistence.create() / append() / flush()` with a
   deterministic `session-<uuid5>` id derived from `(harness, foreign session id)`. That id is what makes
   re-import idempotent without any sidecar ledger.
6. **File** — the session's canonical `cwd` is matched against `ctx.workspaceRegistry.list()`; a missing
   Workspace is created on an explicit import, then `workspace.attachSession(id)` publishes the change
   through the normal Workspace follow stream.
7. **Refresh** — the dialog calls the client session-catalog refresh after importing.

Imported sessions are ordinary durable DSH sessions: they can be opened, renamed, and continued in the
Harness (the resumed agent loop appends its own turn/step records and request headers).

### Workspace-creation policy

To avoid resurrecting a Workspace the user deleted on purpose, scheduled and startup scans only
create a missing Workspace for sessions **created after this plugin process started**. An explicit
manual sync is allowed to create one for older history. Sessions whose `cwd` already has a
Workspace are always attached, regardless of age.

## Security

- Every route is same-origin and passes through the Harness `connection` trust fence before any
  work runs; an unauthenticated request receives `401` and a cross-site one `403`.
- The plugin never reads foreign session content during discovery and never modifies a foreign session
  store; only an explicit import reads one foreign session and writes a **new native DSH session log**
  through `ctx.sessionPersistence`. No filesystem path is ever accepted from a request.
- The import routes use the same fence: `ctx.connection.requestRejection(req)` validates Host/Origin and
  the browser login cookie before any work runs; request bodies are capped (16 KiB for scans, 64 KiB for
  imports), must be `application/json`, and carry only adapter ids and opaque candidate keys.
- Foreign session stores are opened read-only. A scan reads metadata only (header line, file stats); only
  an explicit import reads a transcript, converts it locally, and writes a *new* DSH session. No network
  request is made by the import path and no foreign file is ever rewritten.
- The import writes only Workspace membership and newly created session logs; failure details are
  per-selection and bounded, and host logs never include message text.
- The plugin has no npm dependencies, so installation runs no third-party code.

## Limitations

- Only **materialized** durable sessions are discoverable. A session that has been created in
  another process but not yet written is missed until the next scan.
- Workspace matching is an **exact canonical `cwd`** match, not a parent-directory match.
- `origin: "subagent"` sessions and `migration-required` sessions are skipped by default.
- The plugin does **not** stream another process's ongoing writes into an already open page. It
  solves discovery, Workspace placement, and catalog/metadata refresh; opening a session reads the
  latest durable log.
- Two processes writing the same session concurrently remains unsupported by the Harness itself.
- The `+N` badge and the last-sync tooltip are page-local; they reset on reload.

Cross-harness import adds its own boundaries:

- **A scan replays each foreign session log.** For VS Code Copilot that is the whole append-only log, so a
  scan of a large store costs one sequential pass over the store, and a single very long session may
  transiently use a few hundred MB of memory. Files above 256 MB are skipped rather than replayed.
- **Empty chat shells are not listed.** A Copilot session file created by opening the chat without
  sending a request carries no conversation, so a scan omits it instead of offering an unimportable row.
- **Copilot sessions from a window without a folder** (`emptyWindowChatSessions`) carry no working
  directory, so they are listed but cannot be selected for import.
- **Imported sessions are snapshots.** The foreign session is read once; later turns appended by the
  other harness are not picked up. Re-importing the same foreign session is idempotent (deterministic
  DSH id) and is reported as `already-imported`, so refreshing an import is a future feature.
- **Resuming an imported session appends Harness events.** The first resume opens the log for write,
  appends the resume seed marker (an untagged `session/end-seed {}`), records the current
  model/preset/permission/sandbox state, opens the next turn, and logs the current system prompt: on
  routes with `systemPromptUpdate: in-history` it is appended after the imported history; on other
  routes the protected first system node is rewritten. Imported events are never rewritten. The same
  resume path may add another untagged `session/end-seed {}` at each later cold resume; these markers
  are harmless (only `{ inherited: true }` markers define fork cuts) and never reach the model.
- **There is no delete/repair API for sessions.** The importer validates the complete artifact through
  the Harness restore path before the first append and writes it as one append batch; a failure before
  that append leaves nothing behind. Once appended the log is durable: an import that later proves
  unreadable cannot be repaired in place — its session directory/Workspace membership must be removed
  (or the session deleted by the user's tooling) before re-importing, because the deterministic id
  makes a plain re-import skip as already-imported.
- **Foreign transcripts are normalized, not reproduced exactly.** Tool calls without a recorded result
  get a synthetic interrupted-result error (`TOOL_OUTCOME_UNKNOWN`); tool results without a preceding
  call are dropped (counted in stats); images are downgraded to text; imported assistant reasoning has
  no provider replay metadata, so the model sees the content but provider stream/prefix replay of
  imported turns is best-effort. Imported tool names that the current DSH preset does not define render
  as generic tool cards.
- **The imported session continues under the current DSH configuration,** not the foreign harness's:
  first resume uses the default Agent preset and current default model unless the session recorded its
  own selection; the system prompt, available tools, and permission/sandbox policy are the Harness's.
- **The foreign `cwd` must resolve at import time** (it is canonicalized for the Workspace); sessions
  whose working directory no longer exists are refused rather than attached to an unrelated Workspace.
- Imported event `time`s keep the foreign chronology (clamped to now, monotonic); only
  `header.createdAt` is the import time, which is what the sidebar sorts by. Titles are derived from the
  foreign title/first prompt and capped at 60 code points.
- Foreign stores are opened read-only; discovery never reads conversation content, and all import routes
  are same-origin, authenticated, fenced JSON routes that accept no paths.

## Files

| File | Purpose |
|---|---|
| [`index.js`](index.js) | Host plugin: adopt scan, import routes, Workspace attachment, timers |
| [`import/index.js`](import/index.js) | Cross-harness import orchestration: scan → convert → persist → Workspace |
| [`import/events.js`](import/events.js) | Normalized transcript → validated DSH v4 event log |
| [`import/ids.js`](import/ids.js) | Deterministic session ids (UUIDv5) for idempotent imports |
| [`import/registry.js`](import/registry.js) | Adapter scanning, candidate cache, Workspace hints |
| [`import/adapters/`](import/adapters/) | Adapter contract plus the shipped `pi` and `copilot` adapters |
| [`client.js`](client.js) | Browser plugin: sidebar actions (sync + import dialog), locale dictionaries |
| [`test/`](test/) | Self-contained event-builder and import-orchestrator tests |
| [`cordis.patch.yml`](cordis.patch.yml) | Loader row and default config |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Original plugin icon |
| [`README.zh.md`](README.zh.md) | Chinese documentation |

## Development

No build step is required:

```sh
npm run check   # node --check on every host/client module
npm test        # node --test test/*.test.mjs import/adapters/*.test.mjs
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
```

The adapter tests read the machine's real stores when present and skip gracefully otherwise (both are
read-only): `~/.pi/agent/sessions` for pi, and the VS Code `workspaceStorage/.../chatSessions` stores for
Copilot. Copilot sessions are replayed through the same `kind 0/1/2/3` operation-log semantics VS Code
itself uses, and the real sessions present on the host are listed and read into the adapter contract
when a store exists.

To test in a live profile, install the checkout as a local bundle
(`plugin_manager install_bundle /absolute/path/to/checkout`). A directory install is linked into the
profile, so after editing host code toggle the plugin row/bundle off and on (no app restart); client
code is a browser module and a page refresh (or the harness client HMR frame) is enough when it changes.
Before trusting a conversion, the importer validates the whole candidate log through the installed
`Session` restore path, and the repository tests pin the event invariants.

## License

[MIT](LICENSE)
