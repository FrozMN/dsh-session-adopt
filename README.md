# dsh-session-adopt

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that finds sessions created **outside the running desktop window** — for example by an IDE's ACP client — and adopts them into their matching Workspace.

It also adds a **Sync sessions** action to the sidebar footer and refreshes the browser's session catalog, so new sessions appear without restarting the Harness.

```
Sidebar
  ...
  ⚙  Settings
  ⟳  Sync sessions   +3
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
- **English and Chinese UI**, following the Harness locale.

## Requirements

- A DeepSeek Harness Web or Desktop profile that mounts the Workspace plugin and the Web sidebar.
- Session persistence (the shipped JSONL backend is fine).
- No npm dependencies; the plugin only uses Node built-ins and the Harness services listed in
  [`index.js`](index.js) (`webServer`, `connection`, `sessionPersistence`, `workspaceRegistry`).

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

Changes restart the plugin, which also re-arms the timers and the startup scan.

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

### Workspace-creation policy

To avoid resurrecting a Workspace the user deleted on purpose, scheduled and startup scans only
create a missing Workspace for sessions **created after this plugin process started**. An explicit
manual sync is allowed to create one for older history. Sessions whose `cwd` already has a
Workspace are always attached, regardless of age.

## Security

- Every route is same-origin and passes through the Harness `connection` trust fence before any
  work runs; an unauthenticated request receives `401` and a cross-site one `403`.
- The routes are read/write over Workspace membership only. The plugin never reads session message
  content, never writes a session log, and never accepts a path from the request.
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

## Files

| File | Purpose |
|---|---|
| [`index.js`](index.js) | Host plugin: scans, Workspace attachment, routes, timers |
| [`client.js`](client.js) | Browser plugin: sidebar action, catalog refresh, locale dictionaries |
| [`cordis.patch.yml`](cordis.patch.yml) | Loader row and default config |
| [`locale/en.json`](locale/en.json), [`locale/zh.json`](locale/zh.json) | Plugin-manager title and description |
| [`icon.svg`](icon.svg) | Original plugin icon |
| [`README.zh.md`](README.zh.md) | Chinese documentation |

## Development

No build step is required:

```sh
node --check index.js
node --check client.js
node -e "for (const f of ['package.json','locale/en.json','locale/zh.json']) JSON.parse(require('fs').readFileSync(f,'utf8'))"
```

To test in a live profile, install the checkout as a local bundle, make the edit, then restart the
plugin from the Plugins page. Client code is a browser module; a page refresh may be needed when the
module changes.

## License

[MIT](LICENSE)
