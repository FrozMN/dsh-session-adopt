# Changelog

All notable changes to this project are documented here.

## 0.3.1 — 2026-11-12

Scan clean-up and documentation accuracy.

### Fixed

- **Empty chat shells are no longer listed.** A Copilot session file created by opening the chat without
  sending a request contains no conversation; it appeared in the import dialog but could only fail with
  `empty-session`. Such files are now omitted from a scan.
- The Copilot scan-cost and adapter-test notes describe the behavior without quoting numbers from one
  particular development environment.

## 0.3.0 — 2026-11-11

VS Code Copilot import, and cross-platform path handling.

### Added

- **`copilot` adapter**: detects and imports GitHub Copilot Chat sessions stored by VS Code.
  Reads `User/workspaceStorage/<id>/chatSessions/` for every VS Code variant (stable, Insiders,
  VSCodium, Code - OSS) plus the folder-less `globalStorage/emptyWindowChatSessions`; the session's
  working directory comes from that workspace's `workspace.json`, so imports land in the Workspace the
  user had open. `COPILOT_USER_DATA_DIR` / `VSCODE_USER_DATA_DIR` override the search.
- **Operation-log replay** for the append-only `.jsonl` chat format introduced by
  microsoft/vscode#286644 (VS Code ~1.109 / Insiders): `kind 0` snapshot, `kind 1` set, `kind 2`
  push/splice, `kind 3` delete, identical to `objectMutationLog.ts`. Legacy single-file `.json`
  sessions are read too.
- Transcript mapping for the Copilot response parts: streamed markdown fragments merge into one text
  block, `thinking` becomes reasoning, `toolInvocationSerialized` becomes a paired
  `tool-call`/`tool` message (structured `resultDetails` output, captured terminal output with escape
  sequences stripped, or the past-tense summary), answered `questionCarousel` prompts are kept as
  text; progress markers, `codeblockUri`, `undoStop`, MCP-server and edit-group parts are dropped.
- Tests: 15 synthetic-fixture tests (replay semantics, workspace mapping, transcript mapping, forged
  and escaping keys, truncated logs, legacy files) plus a real-store integration test that lists and
  reads local Copilot sessions when a store is present.

### Fixed

- **Windows support for cross-harness import.** The host rejected every Windows working directory
  because candidate paths were validated with `startsWith('/')`; absolute-path checks now use
  `path.isAbsolute` in `import/events.js`, `import/index.js` and `import/registry.js`, and a new
  Workspace title is derived with `path.basename` instead of splitting on `/`. Before this change a
  scan reported every session as `cwd-unresolved` on Windows and every import failed with
  `missing-cwd`.
- The adapter tests no longer assume POSIX paths.

## 0.2.0 — 2026-11-10

Cross-harness session import.

### Added

- **Detect sessions from other local agent harnesses** and import them as native DSH sessions.
  The first-class adapter is `pi` (session format v1–v3, active-branch selection, usage tokens, tool
  calls/results); optional adapter slots exist for Claude Code, Codex, Gemini CLI and OpenCode.
  Foreign stores are opened read-only and discovery reads metadata only.
- **Import sessions sidebar action** opening a picker window: harness badge, title, cwd, message count,
  model, target Workspace hint, multi-select, select-all/clear/rescan, per-row outcomes, English and
  Chinese copy, accessible modal behaviour.
- **Validated native session synthesis** (`import/events.js`): one turn per user message, one step per
  assistant response, paired `tool/call`/`tool/result`, an interrupted-result repair
  (`TOOL_OUTCOME_UNKNOWN`) for advertised calls whose result never arrived, a protected empty
  `system/message` surface head so the session can be resumed, and a derived `session/title`.
- **Validate-before-write**: the candidate log is checked through the installed `Session` restore path;
  the durable log is written in one append batch through `ctx.sessionPersistence`.
- **Deterministic session ids** (`import/ids.js`, UUIDv5 over harness + foreign id) make re-import
  idempotent — repeats report `already-imported` instead of duplicating.
- **Workspace creation/attachment**: imports land in the Workspace matching the canonical `cwd`; a
  missing Workspace is created on an explicit import and the change reaches the client through the
  Workspace follow stream.
- **Scriptable routes**: authenticated `GET /session-import/sources`, `POST /session-import/scan`,
  `POST /session-import/import`, `GET /session-import/status`. Request bodies are size-capped JSON and
  carry only adapter ids and opaque candidate keys — never filesystem paths.
- **Configuration**: `importEnabled`, `maxMessages`, `maxCandidates`.
- **Tests**: self-contained event-builder and import-orchestrator suites (`npm test`), plus the `pi`
  adapter integration test over the real local store.

### Changed

- README/README.zh documented the import flow, routes, adapters, configuration and the limitations of
  imported snapshots (no incremental refresh, no session delete/repair API, images normalized to text).
- Security notes clarified: import writes a **new native session log** through `ctx.sessionPersistence`,
  while foreign stores remain read-only.

### Verified

- Real pi sessions convert to logs that pass the Harness v4 restore path; an imported session was
  resumed in a live DSH profile (appended turn, model call, reply) and the resulting log still
  validates.

## 0.1.0 — 2026-11-06

Initial release.

- Host scan of durable sessions created by other processes, attached to the Workspace matching
  each session's canonical `cwd`.
- Startup full scan, active-workspace scan every 2 hours, and focus-driven active scan.
- Automatic Workspace creation for new sessions, gated so a deliberately deleted Workspace is not
  recreated on every restart.
- Sidebar **Sync sessions** action with last-result tooltip and `+N` badge.
- Client session-catalog refresh after a scan, including automatic refresh when Workspace
  membership references an unknown session.
- Auth-fenced `POST /session-adopt/scan` and `GET /session-adopt/status` routes.
- English and Chinese UI and documentation.
