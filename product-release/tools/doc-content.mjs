// Single source of truth for the release document. Every statement here must be traceable to source code,
// configuration, project documentation or observed application behaviour (see FACT_VALIDATION.md).
// Inline markup: **bold**, `code`, [label](url).

export const META = {
  title: 'Cortextrace Product Release Document',
  product: 'Cortextrace',
  tagline: 'Local-first observability and threat detection for AI agents',
  version: '0.1.0',
  release_date: '17 September 2026',
  release_designation: 'First public preview',
  revision: '1.0',
  author: 'Manjunatha M, AI and ML consultants',
  license: 'Apache License 2.0 (open source)',
  company: 'AI and ML consultants',
  founder: 'Manjunatha M',
  website: 'https://aiandmlconsultants.com/',
  email: 'Manjunatha@aiandmlconsultants.com',
  github: 'https://github.com/manjunatha552355-rgb/cortextrace',
  copyright: '© 2026 Manjunatha M, AI and ML consultants',
  classification: 'Public — prepared for open-source release',
};

const S = (name) => `Cortextrace_Annotated_Screenshots/${name}.png`;
const D = (name) => `Cortextrace_Architecture_Diagrams/${name}.svg`;

// ---- block helpers ----
const h1 = (num, title) => ({ t: 'h1', num, title, id: `s${num}` });
const h2 = (text) => ({ t: 'h2', text });
const h3 = (text) => ({ t: 'h3', text });
const p = (text) => ({ t: 'p', text });
const lead = (text) => ({ t: 'lead', text });
const ul = (...items) => ({ t: 'ul', items });
const ol = (...items) => ({ t: 'ol', items });
const table = (head, rows, o = {}) => ({ t: 'table', head, rows, widths: o.widths });
const fig = (shot, caption, o = {}) => ({ t: 'figure', src: S(shot), shot, caption, legend: o.legend !== false, size: o.size ?? 'full' });
const diagram = (name, caption) => ({ t: 'figure', src: D(name), png: `Cortextrace_Architecture_Diagrams/${name}.png`, caption, legend: false, size: 'full' });
const note = (title, text, kind = 'info') => ({ t: 'note', title, text, kind });
const code = (text) => ({ t: 'code', text });
const feature = (o) => ({ t: 'feature', ...o });

export const SECTIONS = [
  // 01 Cover is rendered from META.
  { blocks: [
    h1('02', 'Executive Introduction'),
    lead('Cortextrace is a desktop application for Windows, macOS and Linux that discovers the AI agents running on a computer, records what they do, and flags behaviour that looks risky, with an explanation of why.'),
    p('It belongs to an emerging category that combines **AI-agent observability** (what did the agent do, in which session, in what order) with **endpoint security monitoring** (did anything it did look dangerous). Cortextrace runs entirely on the user\'s machine: data is stored locally, nothing is sent anywhere by default, and no account is needed.'),
    note('Value proposition', 'Developers and security teams increasingly let AI coding agents run shell commands, edit files and call external tools. Cortextrace gives them one place to see which agents are active, reconstruct every session as a timeline, and review explainable detections, without sending prompts or source code to a third party.'),
    note('About the screenshots in this document', 'All screenshots were captured from the actual Cortextrace 0.1.0 application. To avoid exposing personal data, the application was run with an isolated demonstration profile. Agent activity, detections, alerts and risk scores shown were produced by the application\'s own engine from **synthetic telemetry** generated with the bundled generator and sent through the real hook, OpenTelemetry and API endpoints. Risk scores next to real product names (for example Claude Code or Cursor) reflect these injected demonstration scenarios and say nothing about the behaviour of those products. The process tree view shows a harmless demonstration agent process; the agent inventory also lists agents that were genuinely running on the capture workstation.', 'warn'),
    h2('Primary users'),
    table(['User', 'What they use Cortextrace for'], [
      ['Developers using AI coding agents', 'See exactly which commands, files and MCP tools their agents touched; catch unintended destructive or credential-related actions.'],
      ['Security and platform engineers', 'Review detections with evidence, define policies (including approval requirements for supported agents), export events to existing tooling.'],
      ['Engineering leaders and architects', 'Understand agent adoption and behaviour across repositories through analytics, without a cloud service.'],
      ['Agent and tool builders', 'Send structured telemetry from custom agents through the local API or OpenTelemetry and inspect it in the dashboard.'],
    ], { widths: [30, 70] }),
    h2('This release at a glance'),
    table(['Item', 'Value'], [
      ['Product', 'Cortextrace'], ['Version', '0.1.0 — first public preview'], ['Release date', '17 September 2026 (project changelog)'],
      ['License', 'Apache License 2.0'], ['Platforms', 'Windows, macOS, Linux (see section 19 for validation status per platform)'],
      ['Maintainer', 'Manjunatha M, AI and ML consultants'],
      ['Source and downloads', `[${META.github}](${META.github})`],
      ['Distribution', 'Windows NSIS installer and MSI (built and install-tested); macOS DMG/PKG and Linux AppImage/DEB/RPM build targets configured'],
    ], { widths: [30, 70] }),

  ] },

  { blocks: [
    h1('03', 'The Problem'),
    lead('AI agents have moved from suggesting code to acting on the developer\'s machine. The tooling to see what they do has not kept up.'),
    h2('Agents now act, not just suggest'),
    p('Modern coding agents run shell commands, install packages, read and write files across a repository, call MCP servers and reach network services on the user\'s behalf. Many developers run several of them at once: a terminal agent, an IDE assistant, a desktop assistant and sometimes locally built agents.'),
    h2('Visibility gaps'),
    table(['Gap', 'Consequence'], [
      ['No unified inventory', 'It is hard to answer a basic question: which AI agents are installed and running on this machine right now?'],
      ['Fragmented, per-product telemetry', 'Each agent reports (if at all) in its own format — hooks, OpenTelemetry, log files — with no common session model.'],
      ['Tool and command opacity', 'A long agent session can execute dozens of commands and file edits; reconstructing what happened afterwards is manual.'],
      ['Concurrent agents', 'When several agents work at once, activity from different sessions interleaves and is difficult to attribute.'],
      ['Security review without context', 'A risky command, a read of a credential file or a prompt-injection string in tool output may go unnoticed, or be noticed without the surrounding sequence that explains it.'],
      ['Privacy tension', 'Sending prompts and source code to an external monitoring service to gain visibility creates a new exposure.'],
    ], { widths: [30, 70] }),
    h2('Why it matters'),
    ul(
      'Agents operate with the user\'s permissions: whatever the user can delete, read or upload, an agent can too.',
      'Untrusted content (web pages, issue text, MCP tool responses) can carry instructions aimed at the model, so an agent can be steered into unintended actions.',
      'Teams adopting agents need evidence — not guesses — to set sensible guardrails and to investigate when something goes wrong.',
    ),
  ] },

  { blocks: [
    h1('04', 'The Solution'),
    lead('Cortextrace treats every AI agent as an observable workload on the endpoint: it discovers agents, normalises their activity into one event model, analyses each event as it arrives, and presents the result in a desktop dashboard.'),
    table(['Principle', 'How Cortextrace implements it'], [
      ['Agent discovery', 'Process signatures, known installation locations, runtime-reported identity (hooks, OpenTelemetry) and user-defined custom agents.'],
      ['Unified observability', 'One versioned event schema (27 event types) for hooks, OpenTelemetry, the REST API and OS-level collectors, with sessions, correlation ids and trace ids.'],
      ['Security monitoring', 'Layered detection on every event: 39 tested rules, user policies, stateful heuristics and learned activity baselines, with explicit classification of findings.'],
      ['Explainable risk', 'Risk scores per session and per agent across 10 dimensions, each showing its contributing factors and evidence.'],
      ['Real-time visualisation', 'Hook, OpenTelemetry and API events are processed in batches of at most 200 ms and streamed to the dashboard; OS collectors poll on fixed intervals (process 5 s, network 10 s).'],
      ['Local-first', 'SQLite storage in the user profile, loopback-only API, no outbound traffic by default, prompts stored as metadata by default.'],
    ], { widths: [26, 74] }),
    diagram('01-high-level-architecture', 'High-level product architecture: signal sources, the local engine, and storage and user-facing surfaces.'),
  ] },

  { blocks: [
    h1('05', 'Product Overview'),
    lead('Cortextrace is a single desktop application. Its engine runs inside the application process (or headless, from the command line) and serves a dashboard organised into four areas: Monitor, Inventory, Activity and Manage.'),
    fig('03-overview', 'The Overview dashboard summarises agents, sessions, activity and security posture for the selected time range.'),
    h2('Major modules'),
    table(['Module', 'Responsibility', 'Source'], [
      ['Collectors', 'Process tree snapshots, per-process network connection metadata, workspace file watching; supervised with isolation and backoff', '`src/collectors/`'],
      ['Adapter registry', '23 built-in agent adapters and custom agents: identification, hook and OTLP normalisation, integration installers', '`src/adapters/`'],
      ['Event pipeline', 'Queueing, identity, redaction, validation, de-duplication, detection, minimisation, persistence, streaming', '`src/core/engine.ts`'],
      ['Detection, policy, risk, alerts', 'Rules, policies, heuristics, anomaly detection, risk scoring, alert de-duplication and incidents', '`src/detection/`'],
      ['Storage', 'SQLite database with migrations, indexes, retention, integrity checks and export', '`src/storage/db.ts`'],
      ['Local API', 'Token-authenticated REST API, OTLP/HTTP JSON receiver, OpenAPI 3.1 document', '`src/api/`'],
      ['Desktop shell and dashboard', 'Electron main process (tray, notifications, IPC) and React dashboard', '`src/main/`, `src/renderer/`'],
    ], { widths: [24, 56, 20] }),
    h2('User journey'),
    ol(
      '**Install and launch.** The first-run guide discloses every data source and lists agents found on the machine.',
      '**Connect agents (optional).** One click installs native hooks or OpenTelemetry settings for Claude Code, Cursor, Codex and Gemini CLI, after backing up the agent\'s configuration.',
      '**Work normally.** Cortextrace records agent sessions in the background, including when the window is closed to the tray.',
      '**Review.** Live Activity, Sessions and the Timeline show what happened; Threats shows detections grouped into incidents; desktop notifications surface high-severity alerts.',
      '**Tune.** Policies, allowlists, rule toggles, suppressions and privacy modes are adjusted in Policies and Settings.',
    ),
  ] },

  { blocks: [
    h1('06', 'Agent Discovery'),
    feature({
      name: 'Agent discovery and identification',
      what: 'Automatic detection of AI agents that are installed or running on the machine, and assignment of a stable identity to each.',
      why: 'An inventory is the starting point for any review: users cannot assess agents they do not know are present.',
      how: [
        '**Process signatures.** Every 5 seconds the process collector reads the OS process list (PowerShell/CIM on Windows, `/proc` on Linux, `ps` on macOS) and matches executable names, paths and command lines against adapter signatures. Chromium/Electron helper processes are ignored as roots.',
        '**Installed agents.** At startup and every 60 seconds, known installation and configuration locations are checked (for example `~/.claude`, `~/.cursor`, `~/.codex`, `~/.gemini`, VS Code extension folders, application bundles).',
        '**Runtime-reported identity.** Hook requests name their adapter in the URL; OpenTelemetry data is attributed through the resource `service.name`.',
        '**Dynamic discovery.** Interpreter or container processes connected to known LLM API endpoints are recorded as an "LLM client" with `inferred` fidelity.',
        '**Identity.** An agent is identified as `<adapter>@<host id>`; each running instance or reported conversation becomes a separate session.',
      ],
    }),
    diagram('02-agent-discovery-flow', 'Agent discovery flow: process signatures, installed-agent scan, dynamic discovery and runtime-reported identity.'),
    fig('30-agents', 'Agent inventory: running, installed and historically observed agents with process ids, sessions, 24-hour risk and trust status.'),
    fig('31-agent-detail', 'Agent detail drawer for a process-discovered agent.'),
    h2('Supported agents'),
    p('The following adapters are built in. "Installer" means Cortextrace can write the agent\'s native hook or telemetry configuration for the user; all other agents are discovered from processes and installation locations, and can additionally send telemetry through the generic OTLP receiver or REST API.'),
    table(['Agent', 'Discovery', 'Native integration'], [
      ['Claude Code', 'process · install location', 'Hooks (installer) · OpenTelemetry (installer) · approval responses'],
      ['Codex', 'process · install location', 'Hooks (installer) · OpenTelemetry (installer) · approval responses'],
      ['Cursor', 'process · install location', 'Hooks (installer) · approval responses on before-hooks'],
      ['Gemini CLI', 'process · install location', 'OpenTelemetry (installer)'],
      ['Claude Desktop / Cowork', 'process · install location', 'MCP configuration inventory'],
      ['GitHub Copilot (VS Code), GitHub Copilot CLI', 'process · extension / install location', 'Generic OTLP receiver (CLI)'],
      ['Antigravity, Windsurf, Kiro, ChatGPT Desktop', 'process · install location', '—'],
      ['Cline, Roo Code', 'process (extension host) · extension location', '—'],
      ['OpenCode, Aider, goose, Amp', 'process · install location', 'Generic OTLP receiver where the agent supports it'],
      ['Ollama, LM Studio, llama.cpp', 'process · install location', '— (local model servers)'],
      ['MCP server processes', 'process command line', '—'],
      ['Python and Node.js agent frameworks', 'process command line (framework names)', 'REST API / OTLP'],
      ['Custom agents', 'user-defined process names / command-line regex', 'Hook endpoint with event-name mapping; per-agent policies'],
    ], { widths: [30, 32, 38] }),
    note('Platform considerations', 'Process discovery requires no elevated privileges. Processes owned by other users may show partial metadata. On Windows, the working directory of another process is not available without debugging privileges, so process-only sessions on Windows have no workspace; hook and OpenTelemetry integrations provide it.', 'info'),
  ] },

  { blocks: [
    h1('07', 'Multi-Agent Observability'),
    feature({
      name: 'Concurrent agent sessions',
      what: 'Simultaneous tracking of any number of agents and sessions, each isolated by session id and attributed to an agent identity.',
      why: 'Developers commonly run several agents at the same time; without session isolation their activity cannot be separated or explained.',
      how: [
        'Every event carries `agent_id`, `agent_type` and `session_id`. Sessions come from the runtime (Claude Code `session_id`, Cursor `conversation_id`, OTLP `session.id` / `conversation.id`) or from process roots (`proc:<agent>:<pid>:<start>`).',
        'Tool calls and their results are linked by `correlation_id`; detection events reference the triggering event; OpenTelemetry trace and span ids are preserved.',
        'The same action reported by a hook, an OpenTelemetry log and a process snapshot is de-duplicated before storage.',
        'Nested agents (for example an MCP server started by an agent) are tracked as their own agent and do not inherit the parent\'s descendants.',
      ],
    }),
    diagram('04-multi-agent-tracing', 'Multi-agent tracing: four concurrent sessions from different agents and collection methods.'),
    fig('10-sessions', 'Sessions list across all agents with duration, event counts, status and risk.'),
    p('The benchmark suite ingests activity from 150 concurrent sessions; the demonstration dataset used for the screenshots contains 718 sessions across six agent types.'),
  ] },

  { blocks: [
    h1('08', 'Real-Time Activity Monitoring'),
    lead('Cortextrace normalises every observation into one event model and streams it to the dashboard.'),
    diagram('03-event-ingestion-pipeline', 'Event ingestion pipeline with bounded queueing, redaction, validation, de-duplication, detection and minimisation.'),
    table(['Source', 'Latency characteristics', 'What it provides'], [
      ['Agent hooks (Claude Code, Cursor, Codex, custom)', 'Processed within one batch interval (≤ 200 ms)', 'Tool calls, commands, file operations, MCP calls, prompts (metadata by default), approvals, session start/end'],
      ['OpenTelemetry (OTLP/HTTP JSON)', 'Processed within one batch interval', 'Tool results with durations, prompts (length), API requests, errors, approval decisions, spans'],
      ['REST API (`POST /v1/events`)', 'Processed within one batch interval', 'Any of the 27 event types from custom agents and SDKs'],
      ['Process collector', 'Polling, default every 5 s', 'Agent start/stop, session start/end, child processes (commands)'],
      ['Network collector', 'Polling, default every 10 s', 'Remote IP, port and resolved LLM API hostname per agent process — connection metadata only'],
      ['Filesystem collector', 'Event-driven, 300 ms debounce', 'Created / modified / deleted paths in active agent workspaces (attribution inferred)'],
    ], { widths: [28, 26, 46] }),
    fig('05-live-activity', 'Live Activity: a virtualised stream of normalised events across all agents.'),
    fig('06-event-inspector', 'Every event can be inspected with its schema fields and redacted payload.'),
    h2('Commands and processes'),
    fig('15-commands', 'Command activity across agents with top binaries and fidelity.'),
    fig('29-processes', 'Process tree of a discovered agent (demonstration agent process), showing descendants with command lines.', { size: 'wide' }),
    h2('Files, network and MCP'),
    fig('16-files', 'File operations: reads, modifications, creations, deletions and directory access. File contents are never stored.'),
    fig('18-network', 'Network metadata: destinations contacted by agents and destinations outside the allowlist.'),
    fig('17-mcp', 'MCP inventory from agent configuration files; environment variable values are never stored.'),
    note('Limitations', 'Polling can miss processes that start and exit between snapshots; hook integrations capture those actions. File-change attribution is inferred from workspace ownership and marked as such. Network monitoring records connection metadata only — it does not inspect traffic.', 'warn'),
  ] },

  { blocks: [
    h1('09', 'Session Tracing'),
    feature({
      name: 'Session timeline and replay',
      what: 'A chronological, filterable reconstruction of everything observed in one agent session, with a risk explanation alongside.',
      why: 'Incidents are understood through sequence: what the agent read, ran and changed before and after a risky action.',
      how: [
        'Sessions start with `session_started` (from hooks, OTLP or process discovery) and end with `session_completed` or process exit.',
        'The timeline shows millisecond timestamps, event type, severity, summary, duration and source; tool results and detections are indented under the events they correlate to.',
        'Event groups (commands, files, tools, network, security) and text search narrow the view; the replay control steps through events in order.',
        'Each timeline entry expands to its redacted payload and links to the raw event and its correlated parent.',
      ],
    }),
    fig('11-session-detail', 'Session detail: summary, timeline with replay, and the risk explanation for the session.'),
    fig('12-session-expanded', 'An expanded detection event within the session timeline.'),
    fig('09-timeline', 'Global timeline across agents with search, severity filter and export to JSONL or CSV.'),
  ] },

  { blocks: [
    h1('10', 'Security Intelligence'),
    lead('Detection runs on every event as it is processed. Findings distinguish facts from indicators and from confirmed policy violations — nothing is labelled malicious from a pattern alone.'),
    diagram('05-security-detection-pipeline', 'Security detection pipeline: four detection layers, the detection record, and downstream timeline events, risk and alerts.'),
    h2('Detection layers'),
    table(['Layer', 'What it detects', 'Output classification'], [
      ['Deterministic rules (39)', 'Destructive commands, privilege elevation, download-and-execute, encoded or obfuscated commands, reverse-shell indicators, living-off-the-land binaries, persistence, disabled security controls, package installs, credential and secret access, cloud metadata access, uploads, sensitive files, agent control-file edits, CI/IaC edits, exfiltration services, prompt-injection phrasing, hidden Unicode, markdown-image exfiltration, sensitive tool arguments', 'Suspicious indicator or observation (per rule)'],
      ['Secret exposure', 'Secret formats discovered by redaction in tool input or output (values are never stored)', 'Suspicious indicator'],
      ['Policies', 'User-defined conditions on any event field', 'Observation (observe mode) or policy violation (alert / require approval)'],
      ['Heuristics', 'Mass file modification or deletion, large repository change, credential access followed by outbound transfer within 120 s, denied action executed', 'Suspicious indicator, observation or policy violation'],
      ['Anomaly and first-seen', 'Event rate far above the agent type\'s learned baseline; first connection to a non-allowlisted destination; first call to an unconfigured MCP server', 'Suspicious indicator or observation'],
    ], { widths: [20, 56, 24] }),
    p('Every rule ships with positive and negative examples that are executed by the automated test suite. Each detection records rule id, severity (INFO to CRITICAL), confidence, risk dimension, reason, evidence snippet, recommended action and related events.'),
    fig('07-threats-incidents', 'Threats: alerts grouped into incidents with severity summary, triage actions and risk dimensions.'),
    fig('08-detection-detail', 'Detection detail with classification, recommended action, evidence and the triggering event.'),
    h2('Policies'),
    p('Policies let users decide what should be flagged. Three modes are available: **observe** (record only), **alert** (policy violation) and **require approval**. Require-approval policies are evaluated synchronously during the hook request; for Claude Code and Codex `PreToolUse` hooks Cortextrace returns `permissionDecision: "ask"`, and for Cursor before-hooks `permission: "ask"`. During documentation validation a Claude Code `PreToolUse` request for `npm run deploy --prod` returned an "ask" decision naming the policy.'),
    fig('19-policies', 'Policies with enable switch, mode, severity and scope.'),
    fig('20-rules', 'Built-in rule catalogue with per-rule enable switches.'),
    h2('Alerts and incidents'),
    ul(
      'Alerts are created for detections at or above a configurable severity (default MEDIUM).',
      'Repeated alerts with the same rule, session and normalised evidence within the de-duplication window increase a counter instead of notifying again.',
      'Alerts in the same session within 30 minutes share an incident.',
      'Alerts can be acknowledged, suppressed or reopened; suppressions can be scoped to an agent type.',
      'Channels: dashboard, desktop notifications (default HIGH and above), `alerts.jsonl` in the data directory, and an optional webhook that carries alert metadata only.',
    ),
  ] },

  { blocks: [
    h1('11', 'Agent Risk Analysis'),
    feature({
      name: 'Explainable risk scoring',
      what: 'A 0–100 risk score for every session (all detections) and every agent (last 24 hours), with a per-dimension breakdown and the list of contributing factors.',
      why: 'A number without reasons cannot be acted on or trusted. Every point in a Cortextrace score traces back to a specific detection and its evidence.',
      how: [
        'Each detection contributes **severity points × confidence × classification weight**. Severity points: INFO 0, LOW 6, MEDIUM 18, HIGH 40, CRITICAL 75. Weights: observation 0.5, suspicious indicator 1.0, policy violation 1.2.',
        'Repeats of the same rule count at 25%, at most three times.',
        'Contributions are sorted and combined as Σ pᵢ × 0.7^rank, capped at 100, so a single critical finding dominates while many small findings still accumulate.',
        'The same formula yields scores for 10 dimensions: command, filesystem, network, credential, privilege, persistence, data access, MCP/tool, anomaly and policy.',
        'Levels are configurable; defaults: low ≥ 15, medium ≥ 40, high ≥ 65, critical ≥ 85.',
      ],
    }),
    diagram('06-risk-analysis-flow', 'Risk analysis flow from detections to an explained score.'),
    p('The risk explanation panel on the session page (see Figure in section 09) lists every factor with its points, classification, confidence, dimension and evidence.'),
  ] },

  { blocks: [
    h1('12', 'Interactive Security Dashboard'),
    lead('The dashboard is organised into Monitor (Overview, Live Activity, Threats, Timeline), Inventory (Agents, Sessions, Relationships, Processes), Activity (Commands, Files, Tools, Network, MCP) and Manage (Policies, Analytics, System Health, Settings).'),
    table(['Capability', 'Implementation'], [
      ['KPIs', 'Active agents and sessions, events per minute, commands, file changes, tool and MCP calls, network connections, detections, critical/high counts; each tile links to its detail page'],
      ['Charts', 'Stacked time-series columns with per-interval hover tooltips and toggleable legends; bar lists; hour-of-week heatmap; duration histogram'],
      ['Time range', 'Global selector: 15 minutes, 1 hour, 24 hours, 7 days, 30 days'],
      ['Filters and search', 'Severity, agent, event group, classification, status and text search; server-side search on the Timeline'],
      ['Drill-down', 'Chart columns open the Timeline for that interval; top lists open filtered views; events link to sessions and correlated events'],
      ['Live updates', 'Coalesced event stream (≤ 1,000 events per 500 ms) while the window is visible; pause and resume on Live Activity; pages refresh periodically'],
      ['Export', 'Events as JSONL or CSV; diagnostics bundle without events or tokens'],
      ['Themes and accessibility', 'Light and dark themes (system, light or dark), reduced-motion and reduced-transparency support, keyboard-focusable controls'],
    ], { widths: [22, 78] }),
    fig('04-overview-security', 'Overview (lower section): detections by severity, top rules and top commands.'),
    fig('28-overview-dark', 'The same Overview in the dark theme.', { legend: false }),
  ] },

  { blocks: [
    h1('13', 'Agent Relationship Graph'),
    feature({
      name: 'Relationship graph',
      what: 'An interactive force-directed graph of agents, sessions, processes, commands, files, directories, tools, MCP servers, network endpoints and security events.',
      why: 'Relationships reveal what tabular lists hide: which session touched which files, which MCP server exposed which tools, and where detections cluster.',
      how: [
        'The graph is built from up to 3,000 events in the selected scope (time range, one agent or one session) and keeps the 400 most connected or risky nodes.',
        'Edges are typed: belongs_to, spawned, executed, read, modified, called, connected_to and detected_by.',
        'Node size reflects occurrences; a ring marks nodes with elevated risk. Nodes can be dragged; the canvas pans and zooms; selecting a node highlights its neighbours.',
      ],
    }),
    diagram('07-relationship-graph-concept', 'Relationship graph concept: node types and typed edges.'),
    fig('13-graph-session', 'Relationship graph scoped to one session.'),
    fig('14-graph-selection', 'Selecting a node shows its details and highlights direct neighbours.'),
  ] },

  { blocks: [
    h1('14', 'Analytics'),
    lead('Analytics summarise behaviour over time for the selected range, using the same local database.'),
    fig('21-analytics', 'Agent usage trend, activity by type and per-agent comparison.'),
    fig('22-analytics-behaviour', 'Risk trend by dimension, threat frequency, hour-of-week activity and command categories.'),
    fig('23-analytics-baselines', 'Session duration distribution, workspace activity and learned behavioural baselines.'),
    table(['Analysis', 'What it shows'], [
      ['Agent usage and activity by type', 'Events per interval per agent and per event type (commands, file operations, tool and MCP calls, network)'],
      ['Agent comparison', 'Events, sessions, commands, file changes, MCP calls, detections and peak event risk per agent'],
      ['Risk trend and threat frequency', 'Detections over time by risk dimension; most frequent rules with severity'],
      ['Activity by time', 'Hour-of-week heatmap in local time'],
      ['Command categories', 'Version control, package & build, test & lint, filesystem & text, network, cloud & containers, interpreters & shells, other'],
      ['Session durations and workspaces', 'Distribution of session durations; most active workspaces with session counts'],
      ['Behavioural baselines', 'Learned events-per-minute mean and deviation per agent type used by anomaly detection (learning until 30 samples)'],
    ], { widths: [30, 70] }),
  ] },

  { blocks: [
    h1('15', 'Privacy and Security Architecture'),
    lead('Cortextrace is an observability and defensive security tool. It runs visibly, uses no elevated privileges, and keeps data on the device.'),
    fig('01-onboarding-disclosure', 'The first-run screen discloses every data source before monitoring is used.'),
    h2('Data collection boundaries'),
    table(['Source', 'Collected', 'Never collected'], [
      ['Process list', 'Name, executable path, command line (secrets redacted), pid/ppid, start time — for agent processes and their descendants', 'Unrelated processes are evaluated but not stored'],
      ['Connection tables', 'Remote IP, port, resolved LLM API hostname for monitored agent processes', 'Traffic contents, DNS queries, other applications\' traffic'],
      ['Workspace file watching', 'Path, size, created / modified / deleted', 'File contents'],
      ['Agent hooks (opt-in)', 'Tool name, command, file path, MCP server and tool, prompt length and hash', 'File contents from read hooks (discarded on arrival)'],
      ['OpenTelemetry (opt-in)', 'Event names, tool names and durations, token counts, cost', 'Prompts — integrations are installed with prompt logging disabled'],
      ['MCP configuration files', 'Server names, transport, command or URL (redacted), environment variable names', 'Environment variable values'],
    ], { widths: [22, 50, 28] }),
    h2('Redaction and minimisation'),
    ul(
      'Before storage, every payload string is scanned for private keys, AWS access keys, GitHub tokens, Anthropic and OpenAI keys, Google API keys, Slack tokens, Stripe live keys, JWTs, bearer tokens, credentials in URLs and `password=` / `token:`-style assignments; sensitive JSON keys such as `authorization` and `api_key` are masked entirely. Users can add custom patterns.',
      'Strings are truncated at 4 KB after redaction.',
      'Default retention modes: prompts as **metadata** (length and a 16-character SHA-256 prefix), tool output as **metadata** (length), command lines **redacted**. Detection runs before minimisation, so a prompt-injection phrase can be flagged without retaining the prompt.',
      'Events are retained for 30 days (maximum 5 million events) by default; both limits are configurable.',
    ),
    fig('25-settings-privacy', 'Privacy settings: retention modes and protections that are always applied.'),
    h2('Security controls'),
    table(['Area', 'Control'], [
      ['Local API', 'Binds to 127.0.0.1; rejects requests with an Origin header or a non-loopback Host header (browser CSRF and DNS rebinding); JSON-only bodies; separate write-only ingest token and read/manage token compared in constant time; rate limiting; body size caps; schema validation'],
      ['Desktop renderer', 'Context isolation, sandbox, Node integration disabled, allow-listed IPC channels with argument validation and sender checks, blocked navigation and new windows, all permission requests denied, strict Content Security Policy'],
      ['Data at rest', 'Database, configuration and tokens in the user profile; created with owner-only permissions on POSIX systems. The database is not encrypted; OS disk encryption is recommended'],
      ['Outbound traffic', 'None by default except DNS lookups used to recognise LLM API endpoints. Webhook and OTLP export are opt-in and visible in Settings'],
      ['Integrations', 'Agent configuration is only changed on explicit user action, always after a backup; uninstall removes only Cortextrace\'s own entries'],
      ['User control', 'Pause monitoring from the sidebar or tray (incoming data is discarded while paused); per-collector switches; retention and export controls'],
    ], { widths: [20, 80] }),
  ] },

  { blocks: [
    h1('16', 'Technical Architecture'),
    table(['Layer', 'Technology'], [
      ['Desktop shell', 'Electron 44 (Node.js 24.21 runtime)'],
      ['Language', 'TypeScript; the engine has no Electron dependency and also runs headless under Node.js 24'],
      ['User interface', 'React 19 bundled with Vite; SVG charts; d3-force for the relationship graph'],
      ['Storage', 'SQLite via the built-in `node:sqlite` module (WAL mode) — no native add-ons'],
      ['Validation', 'zod schemas for events, configuration and API payloads'],
      ['Packaging', 'electron-builder: NSIS and MSI (Windows), DMG and PKG (macOS), AppImage, DEB and RPM (Linux)'],
    ], { widths: [22, 78] }),
    diagram('08-desktop-application-architecture', 'Desktop application architecture: main process, IPC gateway and sandboxed renderer.'),
    h2('Storage'),
    p('Events, sessions, agents, detections, alerts, inventory and baselines are stored in one SQLite database with indexes on time, session, agent, event type, agent type, workspace, tool and correlation id. Schema changes are versioned through migrations. Integrity is checked at startup and daily; if the database cannot be opened or fails the check, it is moved aside and a fresh database is created, and the dashboard shows a banner.'),
    h2('Resilience'),
    ul(
      'Each collector runs on its own schedule; a failing collector is marked degraded and retried with exponential backoff without affecting others.',
      'An adapter that throws is counted in System Health; other adapters continue.',
      'The ingest queue is bounded at 50,000 events; overflow is dropped and counted rather than exhausting memory.',
      'A failed batch is logged and counted; the pipeline continues with the next batch.',
      'If the API or OTLP port is in use, local monitoring continues and the dashboard explains which endpoint is unavailable.',
    ),
    h2('Measured performance'),
    p('Measured on Windows 11 with `npm run bench` (200,000 synthetic events across 150 sessions, with a detection rate far above typical real-world activity):'),
    table(['Measurement', 'Result'], [
      ['Burst ingestion through the full pipeline', '≈ 2,500 events/s (≈ 149,000 events/min)'],
      ['Sustained 12,000 events/min for 20 s', '0 events dropped'],
      ['Latest 200 events', '6.6 ms'],
      ['Session timeline, 5,000 rows', '44 ms'],
      ['Type filter and text search, 234,000 rows', '152 ms'],
      ['Relationship graph, 3,000 events', '64 ms'],
      ['Overview aggregates, 150,000 events in range', '0.28 s'],
      ['Overview aggregates, 234,000 events in range', '2.1 s (results cached for 10 s)'],
    ], { widths: [60, 40] }),
    h2('Observability of the observer'),
    fig('32-system-health', 'System Health: pipeline counters, latency percentiles, collectors, adapters, database and diagnostic log.'),
  ] },

  { blocks: [
    h1('17', 'Extensibility'),
    lead('Adding support for an agent means implementing or configuring an adapter — not changing the pipeline.'),
    table(['Extension path', 'Effort', 'Provides'], [
      ['Custom agent (configuration)', 'JSON in Settings, no code', 'Process discovery, a hook endpoint with event-name mapping, per-agent policies'],
      ['Local REST API or OpenTelemetry', 'A few lines in the agent', 'Full structured events from inside the agent; all detection and risk features apply'],
      ['Built-in adapter (code)', 'Implement the `AgentAdapter` interface', 'Identity detection, hook normalisation, approval responses, integration installer, version and capability declaration'],
      ['Detection rules and policies', 'Rule with examples, or policy JSON', 'New detections, automatically tested (rules) or configured per user (policies)'],
    ], { widths: [26, 26, 48] }),
    h2('Sending events from a custom agent'),
    code(`POST http://127.0.0.1:47631/v1/events
Authorization: Bearer <ingest token from tokens.json>
Content-Type: application/json

[
  { "event_type": "session_started", "agent_type": "research-bot", "session_id": "s1", "workspace": "/work/repo" },
  { "event_type": "command_execution", "agent_type": "research-bot", "session_id": "s1",
    "duration_ms": 120, "payload": { "command": "git status" } }
]`),
    p('The API is documented by an OpenAPI 3.1 document at `GET /v1/openapi.json`. OpenTelemetry data can be sent as OTLP/HTTP JSON to `http://127.0.0.1:4318/v1/logs`, `/v1/traces` and `/v1/metrics`.'),
    fig('24-settings-integrations', 'Integrations: native hooks and telemetry per agent, with local endpoints for any compatible agent.'),
    note('Plugin model', 'In this release, extensions are adapters compiled into the application or custom agents defined in configuration. Loading third-party adapter code at runtime is not supported.', 'info'),
  ] },

  { blocks: [
    h1('18', 'Installation and Getting Started'),
    h2('System requirements'),
    table(['Platform', 'Requirement'], [
      ['Windows', 'Windows 10 or 11, x64 (NSIS installer also built for arm64 by configuration)'],
      ['macOS', 'DMG for Apple silicon and Intel, universal PKG (build targets configured)'],
      ['Linux', 'AppImage, DEB (x64, arm64), RPM (x64); a StatusNotifier host is needed for the tray icon'],
      ['From source', 'Node.js 24 or later'],
    ], { widths: [22, 78] }),
    h2('Installation'),
    p(`Installers are published on the [GitHub Releases page](${META.github}/releases). The 0.1.0 release provides the Windows NSIS installer and MSI package built and install-tested for this document; macOS and Linux packages are produced by the repository\'s release workflow once it has been run on those platforms.`),
    ol(
      '**Windows:** run `Cortextrace-0.1.0-win-x64.exe` (per-user installation, no administrator rights) or deploy `Cortextrace-0.1.0-win-x64.msi`. Silent installation: `Cortextrace-0.1.0-win-x64.exe /S`. Release builds without a code-signing certificate trigger a SmartScreen prompt.',
      '**macOS:** open the DMG and drag Cortextrace to Applications, or run the PKG.',
      '**Linux:** run the AppImage, or install the DEB / RPM package with the system package manager.',
      '**From source:** `npm ci`, `npx electron scripts/icons.cjs`, `npm run build`, `npm start`. A headless engine is available with `npm run engine`.',
    ),
    h2('First launch'),
    fig('02-onboarding-agents', 'The first-run guide lists agents found on the machine and offers one-click integrations.'),
    ol(
      'Review the disclosure of data sources.',
      'Connect hooks or telemetry for detected agents (optional; restart the agent afterwards).',
      'Choose whether to start at login, then open the dashboard.',
    ),
    h2('Initial configuration'),
    fig('26-settings-general', 'General settings: background operation and collectors.'),
    fig('27-settings-alerts', 'Alert routing: thresholds, notifications, de-duplication, webhook and suppressions.'),
    h2('Basic workflow'),
    ol(
      'Work with agents as usual; Cortextrace records sessions in the background.',
      'Check the Threats badge or desktop notifications for new alerts.',
      'Open an incident, review the evidence and the session timeline, then acknowledge or suppress.',
      'Refine policies, allowlists and privacy modes as needed.',
    ),
  ] },

  { blocks: [
    h1('19', 'Supported Platforms and Capabilities'),
    table(['Capability', 'Windows', 'macOS', 'Linux'], [
      ['Desktop app, tray, notifications', 'Validated', 'Implemented', 'Implemented'],
      ['Process discovery', 'Validated (PowerShell / CIM)', 'Implemented (`ps`)', 'Implemented (`/proc`)'],
      ['Network metadata', 'Validated (`Get-NetTCPConnection`)', 'Implemented (`lsof`)', 'Implemented (`/proc/net/tcp`)'],
      ['Process working directory', 'Not available', 'Implemented (`lsof`)', 'Implemented (`/proc/<pid>/cwd`)'],
      ['Workspace file watching', 'Implemented', 'Implemented', 'Implemented (subject to inotify limits)'],
      ['Start at login', 'Implemented', 'Implemented', 'Manual autostart entry (documented)'],
      ['Installers', 'NSIS and MSI built and install-tested', 'DMG / PKG configured', 'AppImage / DEB / RPM configured'],
    ], { widths: [28, 24, 24, 24] }),
    p('**Validated** means exercised on real hardware for this release: the Windows installer was installed silently, the installed application passed the automated end-to-end test across all dashboard pages, and it uninstalled cleanly. **Implemented** means the code and packaging configuration exist and unit tests cover the platform-independent logic, but the capability has not yet been run on that operating system for this release; continuous-integration workflows for macOS and Linux are included in the repository.'),
    note('Platform-specific limitations', 'Windows does not expose other processes\' working directories without debug privileges. macOS may prompt for access when watching workspaces in protected folders. Linux file watching on very large repositories may require raising the inotify watch limit. Code signing and notarization require project-owned certificates that are not part of this release.', 'warn'),
  ] },

  { blocks: [
    h1('20', 'Security and Threat Model'),
    h2('Security boundaries'),
    ul(
      '**Trust boundary:** the logged-in user session. Agents, the engine, the database and the dashboard all run as that user.',
      '**Network boundary:** the API and OTLP receiver listen only on the loopback interface; web pages in a browser are refused.',
      '**Renderer boundary:** the dashboard runs sandboxed and reaches the engine only through validated IPC channels.',
      '**Export boundary:** data leaves the device only through a user-configured webhook or OTLP endpoint.',
    ),
    h2('Threat categories considered'),
    table(['Threat', 'Mitigation', 'Residual risk'], [
      ['Remote attacker reaching the API', 'Loopback binding', 'None known'],
      ['Malicious web page (CSRF, DNS rebinding)', 'Origin and Host checks, JSON-only bodies, bearer tokens', 'None known for the token-protected API'],
      ['Other local processes as the same user', 'Owner-only file permissions (POSIX), write-only ingest token, configuration changes logged', 'Out of scope: same-user code can forge telemetry or stop the application'],
      ['Agent editing its own hooks or settings', 'Agent control-file rule and self-configuration policy; integration status in Settings', 'Edits outside observed paths or before start are not seen'],
      ['Secrets leaking into Cortextrace data', 'Redaction before storage, metadata-only prompts by default, no file contents', 'Unrecognised secret formats; custom patterns available'],
      ['Crafted payloads (injection, denial of service)', 'Schema validation, size caps, rate limiting, bounded queue, parameterised SQL, escaped rendering, strict CSP', 'A local process can still send traffic up to the rate limit'],
      ['Detection evasion by a deliberately malicious agent', 'Multiple independent sources, obfuscation and encoding rules, hooks capture commands before execution', 'Polling gaps; no kernel-level telemetry'],
      ['Misuse as surveillance software', 'Always visible, full disclosure at first run, pause control, no stealth mode, no remote upload by default', 'Exports configured by a local administrator'],
    ], { widths: [26, 44, 30] }),
    h2('Detection philosophy'),
    p('Cortextrace separates **telemetry** (what was observed, with its fidelity), **detections** (rule, policy, heuristic or anomaly matches with confidence) and **policy violations** (breaches of rules the user configured). Suspicious indicators require human judgement; Cortextrace does not claim malware detection or classify intent.'),
    h2('False-positive considerations'),
    ul(
      'Several rules are observations by design (for example package installation and CI/infrastructure edits).',
      'Trusted destinations and MCP servers can be added to allowlists; individual rules can be disabled; alerts can be suppressed per rule and agent.',
      'Prompt jailbreak phrasing is intentionally LOW severity with 40% confidence, because users often quote such text legitimately.',
    ),
  ] },

  { blocks: [
    h1('21', 'Product Release Summary'),
    h2('Implemented capabilities'),
    ul(
      'Desktop application with tray, notifications, start at login, pause, first-run onboarding and light and dark themes.',
      'Discovery of 23 built-in agent types, dynamic LLM-client discovery and configurable custom agents.',
      'Collectors for process trees, network connection metadata and workspace file changes, with supervision and backoff.',
      'One-click integrations for Claude Code (hooks, OpenTelemetry), Codex (hooks, OpenTelemetry), Cursor (hooks) and Gemini CLI (OpenTelemetry).',
      'OTLP/HTTP JSON receiver and token-authenticated REST API with an OpenAPI 3.1 document; headless engine.',
      'Versioned event schema with 27 event types, redaction, privacy modes, de-duplication across sources.',
      'SQLite storage with retention, integrity checks and automatic recovery; JSONL and CSV export; optional OTLP export.',
      '39 tested detection rules, policies with approval responses, heuristics, anomaly baselines and first-seen detection.',
      'Explainable risk scoring across 10 dimensions; alerts with de-duplication, incidents and suppressions.',
      'Seventeen dashboard pages including session timelines with replay, a relationship graph, analytics and system health.',
      'Automated tests (81 passing), desktop end-to-end test, performance benchmark, CI and release workflows, license audit.',
    ),
    h2('Known limitations'),
    table(['Area', 'Limitation'], [
      ['Platforms', 'macOS and Linux builds and collectors are implemented but not yet validated on those systems for this release'],
      ['Signing and updates', 'Installers are unsigned in this release; there is no automatic update mechanism (planned after signing)'],
      ['Collection', 'Process and network collection is polling-based; short-lived processes may be missed without hook integrations; network data is metadata only'],
      ['Attribution', 'File changes are attributed by workspace (inferred); Windows provides no working directory for process-only sessions'],
      ['Integrations', 'Hook and OpenTelemetry mappings for Cursor, Codex and Gemini CLI follow their documented formats and are covered by tests with representative payloads; this release did not exercise them against live installations'],
      ['Storage', 'Database is not encrypted at rest; overview aggregates slow down beyond roughly 200,000 events in the selected range (cached for 10 s)'],
      ['Extensibility', 'No runtime loading of third-party adapter code'],
      ['Agent detail', 'Capabilities and install paths are shown only for agents also found in known installation locations'],
      ['Tamper resistance', 'Not designed to resist an attacker with code execution as the same user'],
    ], { widths: [20, 80] }),
    h2('Roadmap'),
    ul(
      'Validate and publish signed builds for macOS (notarized) and Linux; Authenticode signing for Windows.',
      'Opt-in automatic updates with signature verification.',
      'Optional encrypted storage.',
      'Opt-in enhanced collection using OS event tracing facilities behind an explicit permission step.',
      'Declarative multi-step correlation rules and broader rule taxonomy references.',
      'Additional native integrations and verified payload contracts for more agents.',
      'Full-text search for very large histories and forwarding templates for common SIEM products.',
    ),
  ] },

  { blocks: [
    h1('22', 'Company and Contact'),
    lead('Cortextrace is created and maintained by Manjunatha M at AI and ML consultants.'),
    table(['Field', 'Value'], [
      ['Company', META.company],
      ['Founder and maintainer', META.founder],
      ['Website', `[${META.website}](${META.website})`],
      ['Email', `[${META.email}](mailto:${META.email})`],
      ['GitHub repository', `[${META.github}](${META.github})`],
    ], { widths: [26, 74] }),
    h2('Open-source project'),
    table(['Item', 'Detail'], [
      ['License', 'Apache License 2.0 (`LICENSE` in the repository); third-party components listed in `THIRD_PARTY_NOTICES.md`'],
      ['Source code', `[${META.github}](${META.github})`],
      ['Releases and installers', `[${META.github}/releases](${META.github}/releases)`],
      ['Issues and feature requests', `[${META.github}/issues](${META.github}/issues)`],
      ['Contributing', '`CONTRIBUTING.md` — development setup, test commands, rule and adapter checklists'],
      ['Security reporting', `\`SECURITY.md\` — private reporting through GitHub Security Advisories on the repository, or by email to [${META.email}](mailto:${META.email}). Please do not open public issues for vulnerabilities.`],
      ['Code of conduct', '`CODE_OF_CONDUCT.md`'],
      ['Documentation', '`docs/` — architecture, event schema, detection and risk, privacy, threat model, installation, adapters, design decisions, releasing'],
    ], { widths: [26, 74] }),

  ] },
];
