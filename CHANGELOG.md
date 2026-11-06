# Changelog

All notable changes to this project are documented here.

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
