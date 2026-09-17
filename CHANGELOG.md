# Changelog

All notable changes are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [SemVer](https://semver.org/).

## [0.1.0] - 2026-09-17

First public preview.

### Added
- Desktop app for Windows, macOS and Linux: tray, desktop notifications, start at login, pause monitoring, first-run onboarding with a data-source disclosure, light and dark themes.
- Discovery of 23 built-in agent types from process metadata and configuration locations; custom agents via configuration; discovery of unidentified processes that call LLM APIs.
- Collectors: process tree snapshots (Windows/Linux/macOS), per-process network connection metadata, workspace file watching. Each is supervised with isolation and backoff.
- Integrations with one-click install/remove and backups: Claude Code hooks and OpenTelemetry, Cursor hooks, Codex hooks and OpenTelemetry, Gemini CLI telemetry.
- OTLP/HTTP JSON receiver (logs, traces, metrics) and an authenticated local REST API with OpenAPI 3.1.
- Versioned event schema; redaction of secrets; privacy modes for prompts, tool output and command lines.
- SQLite storage with WAL, indexes, retention, integrity checks with automatic recovery, and JSONL/CSV export; optional OTLP export.
- Detection engine: 39 tested rules, policy engine (observe / alert / require approval), heuristics, learned activity baselines, first-seen destinations and MCP servers.
- Explainable risk scores per session and agent across 10 dimensions.
- Alerts with dedupe, suppression, incident grouping, JSONL log and webhook.
- Dashboard: Overview, Live Activity, Threats, Timeline, Agents, Sessions with replay and risk explanation, Relationship graph, Processes, Commands, Files, Tools, Network, MCP, Policies, Analytics, System Health, Settings.
- Synthetic agent generator, unit/integration/API/collector/rule tests, desktop E2E, performance benchmark, CI and release workflows.
