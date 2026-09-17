# Cortextrace 0.1.0 — Feature inventory

How each feature was checked:

- **Source.** The implementing code is in the repository at `F:\Cortextrace\Cortextrace`.
- **App.** Observed in the running application during the documentation capture, 17 September 2026.
- **Tests.** Covered by `npm test` (81 tests passing).
- **E2E.** Covered by the desktop end-to-end test.

Classifications:

- **Implemented** means it exists and was exercised.
- **Partial** means it exists, but with the noted gaps.
- **Platform dependent** means behaviour differs by operating system.
- **Not implemented** means it is absent.

| # | Feature category | Classification | Evidence | Notes |
|---|---|---|---|---|
| 1 | Desktop application (window, tray, notifications, start at login, pause, onboarding, themes) | Implemented | `src/main/main.ts`, `src/renderer/App.tsx`; App; E2E; Windows installer install/run/uninstall | Start at login on Linux needs a manual autostart entry. |
| 2 | Agent discovery (process signatures, install locations) | Implemented / platform dependent | `src/collectors/process.ts`, `src/collectors/os.ts`, `src/adapters/builtin.ts`; App (demo Node agent and real running agents detected) | Validated on Windows only. |
| 3 | Agent identification (23 built-in adapters, custom agents, LLM-client discovery) | Implemented | `src/adapters/registry.ts`; unit tests | LLM-client discovery was not exercised during capture. |
| 4 | Multi-agent monitoring | Implemented | App: 718 sessions across 6 agent types in the demo DB; benchmark with 150 concurrent sessions | — |
| 5 | Session tracking and timeline replay | Implemented | `src/renderer/pages/agents.tsx`; App screenshots 11, 12 | — |
| 6 | Real-time activity stream | Implemented | Live Activity page; stream coalescing in `main.ts` | Hooks, OTLP and API are processed within ≤200 ms batches. OS collectors poll. |
| 7 | Event timeline (global, search, export) | Implemented | Screenshot 09; `Store.queryEvents` | — |
| 8 | Process monitoring (tree, descendants) | Implemented / platform dependent | Screenshot 29; unit tests incl. nested-agent regression | Polling (5 s) can miss short-lived processes. |
| 9 | Command monitoring | Implemented | Hooks, OTLP and process sources; screenshot 15 | — |
| 10 | Filesystem activity | Implemented (partial attribution) | `src/collectors/filesystem.ts`; hook file events in screenshot 16 | Watch-based attribution is inferred. It was disabled during capture; file events shown came from hooks and API. |
| 11 | Network metadata | Implemented / platform dependent | `src/collectors/process.ts` (NetworkCollector); unit test | Metadata only. Screenshot 18 shows API-supplied synthetic events. |
| 12 | MCP monitoring (calls, config inventory, unknown-server detection) | Implemented | Screenshot 17; `scanMcpConfigs`; detector | — |
| 13 | Security detections (39 rules, secret exposure, heuristics, anomaly, first-seen) | Implemented | `src/detection/`; rule example tests; screenshots 07, 08, 20 | — |
| 14 | Risk scoring (10 dimensions, explainable) | Implemented | `src/detection/risk.ts`; unit tests; screenshot 11 | — |
| 15 | Policy engine (observe / alert / require approval) | Implemented | `src/detection/policy.ts`; engine test; live hook returned `permissionDecision: "ask"` (`tools/approval-response.json`) | Approval responses only for runtimes with blocking hooks. |
| 16 | Agent relationship graph | Implemented | Screenshots 13, 14 | Limited to 3,000 events and 400 nodes per view. |
| 17 | Analytics | Implemented | Screenshots 21–23 | — |
| 18 | Alerts (dedupe, incidents, suppression, JSONL, webhook) | Implemented | `src/detection/alerts.ts`; engine tests; screenshot 07 | Webhook delivery was not exercised against a live endpoint. |
| 19 | Desktop notifications | Implemented | `main.ts` notify handler | Not visually captured. |
| 20 | Local storage (SQLite, retention, integrity, recovery) | Implemented | `src/storage/db.ts`; engine tests incl. corruption recovery | No encryption at rest. |
| 21 | Privacy controls (redaction, retention modes, custom patterns) | Implemented | `src/core/redact.ts`; unit tests; screenshot 25 | — |
| 22 | Configuration | Implemented | `src/core/config.ts` (zod-validated, atomic writes); Settings screenshots 24–27 | — |
| 23 | Plugin / adapter architecture | Partial | `AgentAdapter` interface; custom agents via config | No runtime loading of third-party adapter code. |
| 24 | Export (JSONL, CSV, OTLP export, diagnostics bundle) | Implemented | Engine export test; Settings → Data | OTLP export was not exercised against a live collector. |
| 25 | System health (self-observability) | Implemented | Screenshot 32 | — |
| 26 | Cross-platform support | Platform dependent | Windows validated; macOS and Linux code and packaging configured; CI workflows present | macOS and Linux were not run for this release. |
| 27 | Local REST API + OTLP receiver + OpenAPI | Implemented | `src/api/`; API tests (auth, origin, rate limit, validation); used for demo data | — |
| 28 | Integrations installer (Claude Code, Codex, Cursor, Gemini CLI) | Implemented | Unit round-trip tests; installed into the demo profile during capture (screenshot 24) | Not tested against live agent installations. |
| 29 | Headless engine | Implemented | `src/cli.ts`; smoke test (health → ingest → query) | — |
| 30 | Auto-update mechanism | Not implemented | `docs/RELEASING.md` (planned) | — |
| 31 | Code signing / notarization | Not implemented (configuration only) | `electron-builder.yml`, release workflow secrets | Installers are unsigned. |
