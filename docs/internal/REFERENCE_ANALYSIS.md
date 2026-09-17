# Reference analysis and gap analysis (internal)

This is an internal engineering note. Before designing Cortextrace we studied an existing open-source (MIT-licensed) agent-telemetry project. No code, wording, assets or branding were copied. The note records which concepts informed our design and where we deliberately diverged.

## Reference architecture summary

| Area | Reference project |
|---|---|
| Language/stack | Go CLI and endpoint runtime; TypeScript runtime plugins, a browser extension and an SDK; vanilla-JS dashboard; bundled OpenTelemetry Collector and Vector for forwarding |
| Collection | agent hooks (per-runtime mappers), managed plugins/extensions, OTLP (gRPC/HTTP), polling of some session stores/APIs, browser extension teeing web chat streams. **No process, network or filesystem monitoring** (explicit non-goal) |
| Agents | ~24 local runtimes (Claude Code, Cursor, Codex, Gemini CLI, Copilot CLI, Cline, OpenCode, Kiro, goose, …), plus cloud and CI variants |
| Event model | single JSON schema v1.0 (event action/category, harness, session, tool, command, file, MCP, approval, gen_ai.*), content-derived event ids for hook/OTLP dedupe, 64 KiB cap, redaction |
| Storage | append-only JSONL with 10 MiB × 5 rotation; no index or query engine |
| Detection | ~78 declarative YAML rules (CEL match expressions, ordered correlation steps, embedded test fixtures, OWASP LLM / MITRE ATLAS tags), run **offline in batch** by a `scan` command; real-time detection only in a commercial tier |
| Dashboard | loopback HTTP server, read-only pages over recent JSONL |
| Packaging | GoReleaser, signed/notarized macOS pkg, nfpm deb/rpm with systemd units, WiX MSI; self-update from a manifest |
| CI/tests | ~250 Go test files, conformance suite for rules, sandbox harness running a real agent against scenarios |
| Notable limitations | visibility-only unless an external policy provider is configured; no enforcement; uneven approval coverage; content retention defaults to *full*; onboarding sends an email to the vendor; forwarding depends on bundled Vector |

## Concepts we kept (re-implemented independently)

- Normalising many runtimes into one schema, with fields for collection method and fidelity (our `source` and `fidelity`).
- Combining native hooks with OTLP, and de-duplicating overlapping reports.
- Rules that carry their own positive/negative examples, enforced by tests.
- Installing hooks with backups, and identifying our own entries so uninstall is precise.

## Gap analysis: what Cortextrace adds

| Gap in reference | Cortextrace |
|---|---|
| No desktop app; CLI + browser dashboard | Native desktop app on 3 OSes: tray, notifications, login item, onboarding, pause |
| No process/network/filesystem visibility; agents without hooks are invisible | Process-tree discovery and tracking, per-process connection metadata, workspace file watching, discovery of unknown LLM-API clients |
| Batch-only detection in the open-source tier | Real-time streaming detection on every event, alerts within one batch (≤200 ms) |
| JSONL only, no queries | Indexed SQLite, timelines, search, aggregations, retention, integrity recovery, export |
| No risk scoring | Explainable 10-dimension risk per session and agent |
| Enforcement requires an external provider | Built-in policy engine with `require_approval` returned directly to Claude Code / Codex / Cursor hooks |
| Content retention defaults to full; onboarding phones home | Metadata-only prompts by default; zero outbound traffic by default; no account |
| Read-only dashboard | Interactive dashboard: cross-links, drill-down, relationship graph, session replay, alert workflow (ack/suppress/incidents), policy editor, integrations manager |
| Alert handling | Dedupe, incidents, suppression, desktop/webhook/JSONL channels |
| Self-observability limited to doctor/diagnostics | Live collector/adapter health, pipeline latency, drop counters, diagnostics bundle |
| Custom agents need code | Config-defined custom agents with event mappings and per-agent policies |

## Where the reference is stronger (roadmap inputs)

- **Breadth of runtime integrations** (cloud agents, CI mode, browser chat capture, more plugin-based runtimes). Our adapter interface is ready; each needs a verified payload contract.
- **Rule expressiveness**: CEL expressions and ordered multi-step correlation windows. Our heuristics cover a few sequences in code; a declarative correlation DSL is on the roadmap.
- **Rule count and taxonomy tags** (OWASP LLM / MITRE ATLAS on every rule).
- **Fleet forwarding packs** for SIEMs. We provide webhook, JSONL and OTLP export, but no vendor-specific packs.
- **Service-mode deployment** (system daemons, MDM scripts).
