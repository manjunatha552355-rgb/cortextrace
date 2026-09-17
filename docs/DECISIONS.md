# Design decisions

Short architecture decision records. Each one gives the context, the decision, and its consequences.

## ADR-1: Electron + TypeScript, one codebase for engine and UI

**Context.** The product has to install as a native-feeling desktop app on Windows, macOS and Linux, with a tray, notifications and login items. It also needs a headless mode. The build machine had Node 24 but no Rust or Go toolchain. Tauri would need Rust, and a Go engine would need a second language plus IPC.

**Decision.** Electron 44 (Node 24.21) for the shell. The engine, collectors, detection and API are plain TypeScript with no Electron imports, and run under Electron's main process or plain Node. The renderer is React 19, bundled by Vite. Main and preload are bundled by esbuild.

**Consequences.** One language and one test runner (`node --test` with native type stripping, no transpile step). Installers are about 110 MB, which is Electron's baseline. No native Node modules. The engine shares the main process with the window manager, so storage work is batched and heavy aggregates are cached (ADR-4).

## ADR-2: SQLite through `node:sqlite` rather than DuckDB or a JSONL log

**Context.** The workload is a high-frequency append stream of small rows plus interactive point and range queries (session timeline, latest events, filters) and moderate aggregations.

**Options considered.**

| Option | Ingest | Point/range queries | Aggregations | Footprint / packaging | Notes |
|---|---|---|---|---|---|
| Append-only JSONL | fastest | full scans | full scans | none | no indexes; retention = file rotation |
| **SQLite (`node:sqlite`)** | measured below | indexed, ms | good with covering indexes | built into Node/Electron, **zero native deps** | WAL, integrity check, mature |
| DuckDB (`@duckdb/node-api`) | columnar appends are slower per row | slower for point lookups | excellent | ~40 MB native binary per platform/arch; rebuild per Electron ABI | great for offline analytics |

**Decision.** SQLite in WAL mode. `node:sqlite` binds JavaScript numbers as REAL, so bucket arithmetic must `CAST` (there is a regression test for this).

**Measured** (Windows 11, `npm run bench`, 200,000 events across 150 sessions, about 17% of them triggering detections, which is far above real-world rates):

| Metric | Result |
|---|---|
| Burst ingest through the full pipeline (redaction, validation, 39 rules, policies, heuristics, risk, alerts, persistence) | **~2,500 events/s ≈ 149,000 events/min** |
| Sustained 12,000 events/min for 20 s | **0 dropped** |
| Latest 200 events | 6.6 ms |
| Session timeline, 5,000 rows | 44 ms |
| Type filter + text search on 234k rows | 152 ms |
| Relationship graph (3,000 events) | 64 ms |
| Overview aggregates, 234k events inside the window | 2.1 s (cached 10 s) |
| Overview aggregates, 150k events | 0.28 s |
| DB size | 172 MB for 234k events + 34k detections |

A realistic desktop sees hundreds to low thousands of events per minute, so there is two orders of magnitude of headroom. DuckDB was **not benchmarked**, because its packaging cost (native binaries per OS and arch, ABI rebuilds) conflicts with the zero-native-dependency goal. Revisit it for an optional offline analytics export (Parquet) if needed.

**Consequences.** No encryption at rest (SQLCipher would bring back native dependencies). Search uses `LIKE` over a short `summary` column. FTS5 is the upgrade path for very large histories.

## ADR-3: Layered, explainable detection with explicit classifications

**Context.** Pattern matching on agent activity yields many true-but-benign matches. A security product that cries wolf gets muted.

**Decision.** Every finding is classified as an *observation*, a *suspicious indicator* or a *policy violation*, and carries confidence, evidence and a recommended action. Risk is a transparent formula (see DETECTION.md) instead of a model. Rules carry positive and negative examples that are enforced by tests.

**Consequences.** Users can see exactly why a score is what it is and tune it with allowlists, rule toggles and suppressions. Statistical anomaly detection is kept simple (EWMA rate baseline, first-seen sets) and understandable.

## ADR-4: Polling process snapshots, not kernel instrumentation

**Context.** Kernel-level collection (ETW, eBPF, EndpointSecurity) needs elevated privileges, signed drivers or entitlements, and differs completely per OS. The requirements say *least privilege* and *never bypass OS security*.

**Decision.** Unprivileged user-space snapshots: a persistent PowerShell host on Windows, `/proc` on Linux, `ps`/`lsof` on macOS. Default interval 5 s for processes and 10 s for network. Native hooks and OTLP fill in the high-fidelity detail for supported agents. The three sources are de-duplicated.

**Consequences.** Short-lived processes can be missed by polling (documented). No elevation prompt and no drivers. A future opt-in "enhanced collection" module could add ETW/eBPF behind an explicit permission step.

## ADR-5: Hooks call the local API with curl

**Context.** Agent hooks run a shell command. Shipping a helper binary per OS complicates packaging and signing. Starting Electron per hook is slow.

**Decision.** Hook commands are `curl -m 3 … --data-binary @- http://127.0.0.1:<port>/v1/hooks/<adapter>/<event>` with a **write-only** ingest token. curl ships with Windows 10+, macOS and mainstream Linux. On Windows, `curl.exe` is used to avoid the PowerShell alias.

**Consequences.** Hooks fail open when Cortextrace isn't running. The ingest token sits in agent config files; it only permits writing events. Policy decisions (`ask`) can be returned synchronously.

## ADR-6: No auto-updater in 0.1

See RELEASING.md. An updater is a remote code-execution channel and must wait for signing infrastructure.

## ADR-7: License

Apache-2.0 for the project: permissive, with an explicit patent grant, which suits a security tool companies will embed. The dependency license gate allows only MIT, ISC, BSD, Apache-2.0, 0BSD and Unlicense.
