# Fact validation report: Cortextrace Product Release Document v0.1.0

Each claim was checked against the project before the document was finalised. The "Source" column names the evidence used for each claim; "Location" gives the section number(s) in the release document.

| Claim | Source | Verified | Location |
|---|---|---|---|
| Product name "Cortextrace", version 0.1.0 | `package.json` (`productName`, `version`) | Yes | Cover, 02, header/footer |
| Release date 17 September 2026 | `CHANGELOG.md` `[0.1.0] - 2026-09-17` | Yes | Cover, 02 |
| License Apache-2.0 | `LICENSE` (Apache License 2.0 text), `package.json` `license` | Yes | Cover, 02, 22 |
| Maintainer "Manjunatha M", company "AI and ML consultants", website https://aiandmlconsultants.com/, email Manjunatha@aiandmlconsultants.com | Supplied by the publisher on 17 September 2026; recorded in `package.json` `author`, `LICENSE`, `electron-builder.yml` | Yes (publisher-provided) | Cover, 02, 22, footer |
| GitHub repository https://github.com/manjunatha552355-rgb/cortextrace | Created by the publisher's GitHub account; `package.json` `repository` | Yes (checked after creation) | Cover, 02, 18, 22 |
| Phone, LinkedIn, location, designation | Not supplied | Left out (not invented) | — |
| 23 built-in adapters | `tools/facts.json` (from `BUILTIN_ADAPTERS`) | Yes | 04, 05, 06, 21 |
| Installers exist for Claude Code, Codex, Cursor, Gemini CLI only | `facts.json` `installer: true` for exactly these four | Yes | 06, 21 |
| 39 detection rules, each with match/no-match examples tested | `facts.json` (`RULES.length` = 39); `tests/rules.test.ts` | Yes | 04, 10, 21 |
| 27 event types; 10 risk dimensions | `facts.json` (`EVENT_TYPES`, `RISK_DIMENSIONS`) | Yes | 04, 11, 21 |
| Severity points 0/6/18/40/75; class weights 0.5/1.0/1.2; repeats 25% max 3; decay 0.7^rank; cap 100 | `src/detection/risk.ts` | Yes | 11 |
| Default level thresholds 15/40/65/85 | `src/core/config.ts` `risk.thresholds` | Yes | 11 |
| Process poll 5 s, network 10 s, installed-agent scan 60 s | `src/core/config.ts` defaults; `NetworkCollector` discovery every 6th tick | Yes | 04, 06, 08 |
| Batch ≤ 1,000 events or 200 ms; queue 50,000 | `src/core/engine.ts` `BATCH`, flush timer, `QUEUE_LIMIT` | Yes | 04, 08, 16 |
| Stream to UI ≤ 1,000 events per 500 ms while visible | `src/main/main.ts` batch coalescing | Yes | 12 |
| File watch debounce 300 ms, inferred attribution | `src/collectors/filesystem.ts` | Yes | 08 |
| Graph: up to 3,000 events, 400 nodes | `Engine.graph` | Yes | 13 |
| Alerts ≥ MEDIUM default; notifications ≥ HIGH; incidents within 30 min | `config.ts` alerts defaults; `alerts.ts` `INCIDENT_WINDOW_MS` | Yes | 10 |
| Prompt jailbreak rule LOW, confidence 0.4 | `rules.ts` `content.prompt_injection.user_prompt` | Yes | 20 |
| Require-approval returns `permissionDecision: "ask"` for Claude Code | Live API call during capture → `tools/approval-response.json`; engine test | Yes | 10 |
| Integrations install agent telemetry with prompt logging disabled | `builtin.ts` (no `OTEL_LOG_USER_PROMPTS`; `log_user_prompt = false`; `logPrompts: false`); unit test | Yes | 15 |
| Redaction patterns list; 4 KB string cap | `src/core/redact.ts` | Yes | 15 |
| Default retention 30 days / 5,000,000 events; prompts metadata; tool output metadata; command lines redacted | `config.ts` defaults | Yes | 15 |
| API: loopback bind, Origin/Host checks, JSON-only, two tokens, constant-time compare, rate limit, size caps | `src/api/server.ts`; `tests/api.test.ts` | Yes | 15, 20 |
| Renderer hardening and CSP | `src/main/main.ts`, `src/main/preload.ts` | Yes | 15, 16 |
| Owner-only permissions on POSIX; DB not encrypted | `db.ts`/`config.ts`/`engine.ts` `mode 0o600`; no encryption code | Yes | 15, 21 |
| Outbound traffic by default limited to DNS for LLM API recognition | `NetworkCollector.refreshDns`; webhook/OTLP export default null | Yes | 15 |
| Electron 44 / Node.js 24.21, React 19, Vite, d3-force, zod, node:sqlite | `package.json`; runtime probe `process.versions` | Yes | 16 |
| Benchmark figures (≈ 2,500 events/s; 0 dropped at 12,000/min; query latencies) | `npm run bench` output recorded in `docs/DECISIONS.md` | Yes (measured on the capture workstation) | 16 |
| 81 automated tests passing | `node --test tests/*.test.ts` run during documentation validation | Yes | 21 |
| Windows NSIS/MSI built, silently installed, E2E passed on installed build, uninstalled | Build and install session logs | Yes | 02, 18, 19 |
| macOS / Linux not validated on hardware | No runs on those OSes | Yes (stated as a limitation) | 19, 21 |
| 17 dashboard pages | `App.tsx` navigation (17 items) | Yes | 12, 21 |
| Demo dataset: 718 sessions, 6 agent types | `tools/facts.json` `demo_db`; Analytics screenshot | Yes | 07 |
| Screenshots are real application captures using synthetic telemetry | `tools/capture.mjs` (CDP capture of the running app; data via real endpoints) | Yes, disclosed in the document | 02 |
| Agent detail shows capabilities only for agents also found in install locations | Observed in screenshot 31; `discoverInstalled` sets `meta` | Yes (stated as a limitation) | 21 |

## Corrections made during validation

- **Rule count.** Project documentation said 40 rules; the actual count is 39. `README.md`, `CHANGELOG.md`, `docs/DETECTION.md` and `docs/DECISIONS.md` were corrected.
- **Agent count.** The changelog said "24 agent types"; this was corrected to 23 built-in adapters plus dynamic LLM-client discovery.
- **Process attribution bug.** Children of a nested agent were also attributed to the outer agent. The bug is fixed in `src/collectors/process.ts`, and a regression test was added.

## Privacy review

- Screenshots were captured with an isolated demo profile (`--user-data-dir`, demo `HOME`/`APPDATA`).
- **Processes screenshot leak.** The original crop exposed a neighbouring process path containing the Windows username. The strip was removed from both the raw and annotated images.
- **Text scan.** The final PDF and DOCX text was scanned for the username, email domains, and GitHub/OpenAI/AWS key patterns; see the build log in `README.md`. The username check matches whole words only, so the maintainer's published name is not reported as a leak. Result: 0 hits in both the PDF and the DOCX. The only personal details in the documents are the publisher-supplied contact details listed above.
- **Screenshot review.** Screenshots were reviewed visually for usernames, tokens and personal paths.
- **Real agent names.** Agents that were actually running on the workstation appear by product name only. Their risk values come from injected synthetic scenarios, and the document states this.
