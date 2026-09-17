// Generates the architecture diagrams (SVG) used in the release document. Every component shown exists in src/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'Cortextrace_Architecture_Diagrams');
mkdirSync(OUT, { recursive: true });

const C = { ink: '#0B1F3A', text: '#1F2937', sub: '#5B6472', line: '#8A93A3', box: '#FFFFFF', boxStroke: '#CBD2DC', band: '#F3F5F8', accent: '#1F5FAF', accentSoft: '#E6EEF8', warn: '#B45309', warnSoft: '#FDF3E6', crit: '#B42318', critSoft: '#FCEDEC' };
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function svg(w, h, body, title) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" font-family="Segoe UI, system-ui, -apple-system, Helvetica, Arial, sans-serif">
<title>${esc(title)}</title>
<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.line}"/></marker>
<marker id="ahA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${C.accent}"/></marker></defs>
<rect width="${w}" height="${h}" fill="#FFFFFF"/>
${body}
</svg>`;
}

function box(x, y, w, h, title, lines = [], o = {}) {
  const fill = o.fill ?? C.box, stroke = o.stroke ?? C.boxStroke;
  let s = `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="10" fill="${fill}" stroke="${stroke}" stroke-width="${o.sw ?? 1.4}"/>`;
  const ty = lines.length ? y + 24 : y + h / 2 + 5;
  s += `<text x="${x + 14}" y="${ty}" font-size="${o.fs ?? 14}" font-weight="650" fill="${C.ink}">${esc(title)}</text>`;
  lines.forEach((l, i) => { s += `<text x="${x + 14}" y="${y + 44 + i * 17}" font-size="12" fill="${C.sub}">${esc(l)}</text>`; });
  return s;
}
const band = (x, y, w, h, label) => `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="${C.band}"/><text x="${x + 16}" y="${y + 24}" font-size="12" font-weight="700" fill="${C.sub}" letter-spacing="0.06em">${esc(label.toUpperCase())}</text>`;
const arrow = (x1, y1, x2, y2, o = {}) => `<path d="M${x1},${y1} ${o.via ?? ''} L${x2},${y2}" fill="none" stroke="${o.accent ? C.accent : C.line}" stroke-width="${o.w ?? 1.6}" ${o.dash ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${o.accent ? 'ahA' : 'ah'})"/>`;
const label = (x, y, t, o = {}) => `<text x="${x}" y="${y}" font-size="${o.fs ?? 11.5}" fill="${o.color ?? C.sub}" ${o.anchor ? `text-anchor="${o.anchor}"` : ''} font-weight="${o.bold ? 650 : 400}">${esc(t)}</text>`;
const pill = (x, y, t, fill, color) => { const w = t.length * 6.8 + 18; return `<rect x="${x}" y="${y}" width="${w}" height="22" rx="11" fill="${fill}"/><text x="${x + w / 2}" y="${y + 15}" font-size="11.5" font-weight="650" fill="${color}" text-anchor="middle">${esc(t)}</text>`; };

const diagrams = {};

// 1. High-level product architecture
diagrams['01-high-level-architecture'] = svg(1200, 660, [
  band(20, 20, 290, 620, 'Signal sources'),
  box(40, 60, 250, 70, 'Operating system', ['Process list · TCP connection tables']),
  box(40, 145, 250, 70, 'Workspace filesystem', ['Change notifications (fs.watch)']),
  box(40, 240, 250, 70, 'AI agent runtimes', ['Native hooks (curl → local API)']),
  box(40, 325, 250, 70, 'OpenTelemetry', ['OTLP/HTTP JSON logs, traces, metrics']),
  box(40, 410, 250, 70, 'SDK / custom agents', ['REST API: POST /v1/events']),
  box(40, 520, 250, 90, 'Agent configuration files', ['Install locations · MCP server lists', '(read-only scan)']),
  band(340, 20, 560, 620, 'Cortextrace engine (local)'),
  box(360, 60, 230, 150, 'Collector supervisor', ['Process monitor (5 s)', 'Network metadata (10 s)', 'Filesystem monitor', 'isolation + backoff'], { stroke: C.accent }),
  box(360, 240, 230, 170, 'Local API + OTLP receiver', ['127.0.0.1 only', 'bearer tokens (ingest / api)', 'schema validation', 'rate limits · size caps'], { stroke: C.accent }),
  box(360, 520, 230, 90, 'Inventory scan', ['installed agents', 'MCP server inventory']),
  box(620, 60, 260, 150, 'Adapter registry', ['23 built-in adapters', '+ custom agents', 'identity · hook & OTLP', 'normalisation · installers']),
  box(620, 240, 260, 170, 'Event pipeline', ['bounded queue · identity', 'redaction · validation', 'de-duplication · detection', 'privacy minimisation', 'persistence · streaming'], { fill: C.accentSoft, stroke: C.accent }),
  box(620, 430, 125, 180, 'Detection', ['rules', 'policies', 'heuristics', 'anomaly', 'first-seen'], { fs: 13 }),
  box(755, 430, 125, 180, 'Risk & alerts', ['10 risk', 'dimensions', 'dedupe', 'incidents', 'suppression'], { fs: 13 }),
  band(930, 20, 250, 620, 'Storage & surfaces'),
  box(950, 60, 210, 110, 'SQLite (WAL)', ['events · sessions · agents', 'detections · alerts', 'retention · integrity']),
  box(950, 190, 210, 100, 'Desktop app', ['dashboard (17 pages)', 'tray · notifications']),
  box(950, 305, 210, 90, 'Local REST API', ['queries (OpenAPI 3.1)']),
  box(950, 410, 210, 100, 'Alert channels', ['desktop · alerts.jsonl', 'optional webhook']),
  box(950, 525, 210, 85, 'Optional export', ['OTLP/HTTP JSON · JSONL · CSV']),
  arrow(290, 95, 360, 110), arrow(290, 180, 360, 160),
  arrow(290, 275, 360, 290), arrow(290, 360, 360, 325), arrow(290, 445, 360, 370),
  arrow(290, 565, 360, 565),
  arrow(590, 135, 620, 300, { accent: true }), arrow(590, 325, 620, 325, { accent: true }), arrow(750, 210, 750, 240),
  arrow(682, 410, 682, 430, { accent: true }), arrow(745, 520, 755, 520, { accent: true }),
  arrow(880, 300, 950, 115, { accent: true }), arrow(880, 520, 950, 460),
  arrow(590, 565, 950, 140, { via: 'L 605,565 L 605,628 L 915,628 L 915,140', dash: true }),
  arrow(1055, 170, 1055, 190),
].join('\n'), 'High-level product architecture');

// 2. Agent discovery flow
diagrams['02-agent-discovery-flow'] = svg(1200, 560, [
  band(20, 20, 1160, 150, 'Process-based discovery (every 5 s, unprivileged)'),
  box(40, 60, 200, 90, 'Process snapshot', ['pid · ppid · executable', 'command line · start time']),
  box(270, 60, 230, 90, 'Signature match', ['executable name / path', 'command line + interpreter', '(Chromium --type helpers skipped)']),
  box(530, 60, 200, 90, 'Root selection', ['no ancestor of the', 'same agent → root']),
  box(760, 60, 200, 90, 'Session', ['proc:<agent>:<pid>:<start>', 'agent_started / session_started']),
  box(990, 60, 170, 90, 'Descendants', ['child processes →', 'command events']),
  arrow(240, 105, 270, 105), arrow(500, 105, 530, 105), arrow(730, 105, 760, 105), arrow(960, 105, 990, 105),
  band(20, 190, 570, 170, 'Installed-agent discovery (startup + every 60 s)'),
  box(40, 230, 250, 110, 'Known locations', ['~/.claude, ~/.cursor, ~/.codex, ~/.gemini,', 'VS Code extensions, app bundles …', 'MCP config files (names only)']),
  box(320, 230, 250, 110, 'Inventory', ['agent marked installed', 'install paths + capabilities', 'MCP servers → known-server list']),
  arrow(290, 285, 320, 285),
  band(610, 190, 570, 170, 'Dynamic discovery (every 60 s)'),
  box(630, 230, 250, 110, 'LLM API resolution', ['DNS for known LLM API hosts', '(api.anthropic.com, api.openai.com …)']),
  box(910, 230, 250, 110, 'Connection match', ['interpreter/container process', 'connected to those IPs →', '"LLM client" (inferred)']),
  arrow(880, 285, 910, 285),
  band(20, 380, 1160, 160, 'Runtime-reported identity'),
  box(40, 420, 270, 100, 'Hook payload', ['POST /v1/hooks/<adapter>/<event>', 'adapter from URL, session_id / cwd', 'from payload']),
  box(340, 420, 270, 100, 'OTLP resource', ['service.name → adapter', '(claude-code, codex_cli_rs, gemini-cli)', 'unknown → otel.<service>']),
  box(640, 420, 250, 100, 'Custom agents', ['process names / command-line regex', 'event-name mappings', 'per-agent policies']),
  box(920, 420, 240, 100, 'Agent identity', ['agent_id = <adapter>@<host_id>', 'one identity per product per host', 'many concurrent sessions'], { fill: C.accentSoft, stroke: C.accent }),
  arrow(310, 470, 340, 470), arrow(610, 470, 640, 470), arrow(890, 470, 920, 470, { accent: true }),
].join('\n'), 'Agent discovery flow');

// 3. Event ingestion pipeline
const stages = [
  ['Enqueue', ['bounded queue', '≤ 50,000 events', 'overflow is', 'dropped & counted']],
  ['Batch', ['≤ 1,000 events', 'or every 200 ms']],
  ['Identify', ['agent id', 'session id', 'workspace']],
  ['Redact', ['secret formats', 'sensitive keys', '4 KB string cap']],
  ['Validate', ['schema v1 (zod)', 'invalid events', 'dropped & counted']],
  ['De-duplicate', ['hook vs OTLP', 'hook vs process', 'hook vs file watch']],
  ['Detect', ['rules', 'policies', 'heuristics', 'anomaly']],
  ['Minimise', ['prompts: metadata', 'tool output:', 'length only', '(configurable)']],
  ['Persist', ['one SQLite', 'transaction', 'risk + alerts']],
  ['Stream', ['to the UI', '≤ 1,000 events', 'per 500 ms']],
];
diagrams['03-event-ingestion-pipeline'] = svg(1280, 360, [
  band(20, 20, 1240, 320, 'Event pipeline (src/core/engine.ts)'),
  ...stages.map(([t, l], i) => box(36 + i * 122, 70, 108, 150, t, l, { fill: i === 6 ? C.accentSoft : C.box, stroke: i === 6 ? C.accent : C.boxStroke, fs: 13 })),
  ...stages.slice(1).map((_, i) => arrow(145 + i * 122, 145, 157 + i * 122, 145)),
  label(36, 270, 'Sources: hooks, OTLP and REST API (processed within one batch interval) · process snapshots every 5 s · connection tables every 10 s · file watch (event-driven, 300 ms debounce)', { fs: 12.5, color: C.text }),
  label(36, 300, 'Self-metrics recorded along the way: received, stored, dropped, de-duplicated, invalid, batch latency p50/p95.', { fs: 12.5 }),
].join('\n'), 'Event ingestion pipeline');

// 4. Multi-agent tracing
const lane = (y, name, color, events) => [
  `<rect x="40" y="${y}" width="1120" height="96" rx="10" fill="#FFFFFF" stroke="${C.boxStroke}"/>`,
  `<rect x="40" y="${y}" width="6" height="96" rx="3" fill="${color}"/>`,
  label(60, y + 24, name, { fs: 13.5, bold: true, color: C.ink }),
  ...events.map(([x, t, sub, hl]) => `<rect x="${x}" y="${y + 52}" width="${t.length * 7 + 20}" height="30" rx="7" fill="${hl ? C.critSoft : C.band}" stroke="${hl ? C.crit : C.boxStroke}"/>${label(x + 10, y + 71, t, { fs: 12, color: hl ? C.crit : C.text })}${sub ? label(x, y + 46, sub, { fs: 10.5 }) : ''}`),
].join('');
diagrams['04-multi-agent-tracing'] = svg(1200, 540, [
  label(40, 36, 'Concurrent sessions are isolated by session_id and attributed to an agent identity; events inside a session are linked by correlation_id and OpenTelemetry trace/span ids.', { fs: 13, color: C.text }),
  lane(56, 'Claude Code@host · session 7f2a… (hooks + OTLP)', '#2A78D6', [[80, 'PreToolUse: Bash', 'tool_use_id=tu_1'], [300, 'tool_result', 'tool_use_id=tu_1'], [470, 'mcp_call github', ''], [650, 'security_detection: Download piped to interpreter', 'correlation_id → triggering event', true]]),
  lane(164, 'Cursor@host · conversation c91… (hooks)', '#EB6834', [[80, 'beforeShellExecution', ''], [300, 'afterFileEdit src/app.ts', ''], [560, 'beforeMCPExecution', '']]),
  lane(272, 'Codex@host · conversation 4be… (OTLP)', '#1BAF7A', [[80, 'user_prompt (length only)', ''], [330, 'tool_result exec_command', 'duration_ms=820'], [590, 'api_request', '']]),
  lane(380, 'Node agent@host · proc:node-agent:<pid> (process snapshots)', '#6B7280', [[80, 'session_started', ''], [240, 'process_started web_search_tool', ''], [520, 'command_execution', 'descendant pid']]),
  label(40, 510, 'Many instances of one product → one agent_id, many session_ids. Hook, OTLP and process reports of the same action are de-duplicated before storage.', { fs: 12.5 }),
].join('\n'), 'Multi-agent tracing');

// 5. Security detection pipeline
diagrams['05-security-detection-pipeline'] = svg(1200, 560, [
  box(30, 230, 150, 90, 'Normalised event', ['redacted, validated'], { fill: C.accentSoft, stroke: C.accent }),
  band(210, 20, 470, 520, 'Detection layers (per event)'),
  box(230, 60, 430, 80, '1 · Deterministic rules (39)', ['regex on command, path, host, prompt, tool output, arguments', 'each rule tested with match / no-match examples']),
  box(230, 155, 430, 60, 'Secret exposure', ['secret formats found by redaction (values never stored)']),
  box(230, 230, 430, 80, '2 · Policies (user-defined)', ['observe → observation · alert → policy violation', 'require_approval → synchronous "ask" to supporting hooks']),
  box(230, 325, 430, 80, '3 · Stateful heuristics (per session)', ['mass file changes/deletions · large repository change', 'credential access → egress (120 s) · denied → executed']),
  box(230, 420, 430, 100, '4 · Anomaly & first-seen', ['events/minute vs EWMA baseline (z ≥ 4, n ≥ 30)', 'first non-allowlisted destination per agent type', 'first call to an unconfigured MCP server']),
  arrow(180, 275, 230, 100), arrow(180, 275, 230, 185), arrow(180, 275, 230, 270), arrow(180, 275, 230, 365), arrow(180, 275, 230, 470),
  box(720, 170, 200, 210, 'Detection', ['rule id & name', 'classification', 'severity · confidence', 'risk dimension', 'reason · evidence', 'recommended action', 'related event ids'], { stroke: C.accent }),
  arrow(660, 100, 720, 230), arrow(660, 185, 720, 245), arrow(660, 270, 720, 275), arrow(660, 365, 720, 305), arrow(660, 470, 720, 330),
  box(960, 40, 210, 110, 'Timeline event', ['security_detection /', 'policy_violation linked to', 'the triggering event']),
  box(960, 175, 210, 110, 'Risk engine', ['session risk (all time)', 'agent risk (24 h)', 'per dimension']),
  box(960, 310, 210, 210, 'Alerts', ['≥ MEDIUM (configurable)', 'dedupe: rule + session +', 'normalised evidence', 'incidents: same session ≤ 30 min', 'suppressions', '→ desktop (≥ HIGH), alerts.jsonl,', '   optional webhook']),
  arrow(920, 230, 960, 95, { accent: true }), arrow(920, 275, 960, 230, { accent: true }), arrow(920, 320, 960, 415, { accent: true }),
  pill(740, 420, 'observation', C.band, C.sub), pill(740, 450, 'suspicious indicator', C.warnSoft, C.warn), pill(740, 480, 'policy violation', C.critSoft, C.crit),
].join('\n'), 'Security detection pipeline');

// 6. Risk analysis flow
diagrams['06-risk-analysis-flow'] = svg(1200, 430, [
  box(30, 60, 190, 130, 'Detections', ['for a session (all)', 'or agent (last 24 h)']),
  box(250, 60, 250, 130, 'Points per detection', ['severity points:', 'INFO 0 · LOW 6 · MEDIUM 18', 'HIGH 40 · CRITICAL 75', '× confidence × class weight']),
  box(530, 60, 200, 130, 'Repeat control', ['same rule repeats', 'count at 25 %', 'max 3 repeats']),
  box(760, 60, 200, 130, 'Rank decay', ['sort by points', 'score = Σ pᵢ × 0.7^rank', 'capped at 100']),
  box(990, 60, 180, 130, 'Level', ['low ≥ 15 · medium ≥ 40', 'high ≥ 65 · critical ≥ 85', '(configurable)'], { fill: C.accentSoft, stroke: C.accent }),
  arrow(220, 125, 250, 125), arrow(500, 125, 530, 125), arrow(730, 125, 760, 125), arrow(960, 125, 990, 125, { accent: true }),
  band(30, 220, 1140, 190, 'Explanation stored with the score'),
  box(50, 260, 350, 130, 'Per-dimension scores', ['command · filesystem · network · credential', 'privilege · persistence · data access', 'MCP / tool · anomaly · policy', '(same formula per dimension)']),
  box(425, 260, 350, 130, 'Contributing factors', ['rule name · severity · classification', 'confidence · points · evidence snippet', 'linked to the detection and event']),
  box(800, 260, 350, 130, 'Class weights', ['observation × 0.5', 'suspicious indicator × 1.0', 'policy violation × 1.2']),
].join('\n'), 'Risk analysis flow');

// 7. Relationship graph concept
const nodes = [
  ['agent', 600, 200, 'Agent', '#2A78D6', 26, true], ['s1', 420, 200, 'Session', '#4A3AA7', 18], ['s2', 780, 200, 'Session', '#4A3AA7', 18],
  ['cmd', 250, 90, 'Command', '#EB6834', 14], ['file', 250, 200, 'File', '#1BAF7A', 14], ['dir', 250, 310, 'Directory', '#1BAF7A', 14], ['proc', 420, 360, 'Process', '#898781', 14],
  ['tool', 950, 90, 'Tool', '#EDA100', 14], ['mcp', 950, 200, 'MCP server', '#E87BA4', 16], ['net', 950, 310, 'Network endpoint', '#008300', 14], ['sec', 600, 380, 'Security event', '#B42318', 16],
];
const find = (id) => nodes.find((n) => n[0] === id);
const edges = [['s1', 'agent', 'belongs_to'], ['s2', 'agent', 'belongs_to'], ['s1', 'cmd', 'executed'], ['s1', 'file', 'modified / read'], ['s1', 'dir', 'read'], ['s1', 'proc', 'spawned'], ['s2', 'tool', 'called'], ['s2', 'mcp', 'called'], ['mcp', 'tool', 'called'], ['s2', 'net', 'connected_to'], ['sec', 's1', 'detected_by']];
diagrams['07-relationship-graph-concept'] = svg(1200, 460, [
  ...edges.map(([a, b, t]) => { const A = find(a), B = find(b); const mx = (A[1] + B[1]) / 2, my = (A[2] + B[2]) / 2; return `<line x1="${A[1]}" y1="${A[2]}" x2="${B[1]}" y2="${B[2]}" stroke="${t === 'detected_by' ? C.crit : C.line}" stroke-width="1.6"/><rect x="${mx - t.length * 3.3 - 6}" y="${my - 10}" width="${t.length * 6.6 + 12}" height="18" rx="9" fill="#FFFFFF"/>${label(mx, my + 3, t, { anchor: 'middle', fs: 11 })}`; }),
  ...nodes.map(([id, x, y, t, color, r, sq]) => `${sq ? `<rect x="${x - r}" y="${y - r}" width="${r * 2}" height="${r * 2}" rx="8" fill="${color}"/>` : `<circle cx="${x}" cy="${y}" r="${r}" fill="${color}"/>`}${id === 'sec' || id === 'cmd' ? `<circle cx="${x}" cy="${y}" r="${r + 5}" fill="none" stroke="#EC835A" stroke-width="2"/>` : ''}${label(x, y + r + 18, t, { anchor: 'middle', fs: 12.5, bold: true, color: C.ink })}`),
  label(40, 440, 'Nodes: agent, session, process, command, file, directory, tool, MCP server, network endpoint, security event. Node size ∝ occurrences; ring = elevated risk (≥ 40).', { fs: 12.5 }),
].join('\n'), 'Relationship graph concept');

// 8. Desktop application architecture
diagrams['08-desktop-application-architecture'] = svg(1200, 560, [
  band(20, 20, 740, 520, 'Electron main process (Node 24)'),
  box(40, 60, 340, 110, 'Runtime', ['Engine (pipeline, detection, storage)', 'Collector supervisor', 'API server 127.0.0.1:47631', 'OTLP receiver 127.0.0.1:4318']),
  box(400, 60, 340, 110, 'Desktop shell', ['single-instance lock · tray menu', 'notifications (≥ HIGH) · start at login', 'close-to-tray · pause / resume']),
  box(40, 195, 700, 90, 'IPC gateway', ['allow-listed channels · argument validation · sender URL check', 'stream coalescing (≤ 1,000 events / 500 ms, only while window visible)'], { stroke: C.accent }),
  box(40, 310, 340, 110, 'Window hardening', ['contextIsolation · sandbox', 'nodeIntegration off · navigation blocked', 'all permission requests denied']),
  box(400, 310, 340, 110, 'Content Security Policy', ["script-src 'self' · connect-src 'none'", "object-src 'none' · frame-ancestors 'none'"]),
  box(40, 445, 700, 75, 'Data directory (user profile)', ['cortextrace.db · config.json · tokens.json · alerts.jsonl · logs/  (0600 on POSIX)']),
  band(790, 20, 390, 520, 'Renderer (sandboxed)'),
  box(810, 60, 350, 70, 'Preload bridge', ['window.cortex.invoke / onStream / onNavigate'], { stroke: C.accent }),
  box(810, 150, 350, 190, 'React dashboard', ['Overview · Live Activity · Threats · Timeline', 'Agents · Sessions · Relationships · Processes', 'Commands · Files · Tools · Network · MCP', 'Policies · Analytics · System Health · Settings', 'First-run onboarding']),
  box(810, 360, 350, 160, 'UI foundations', ['virtualised event lists', 'SVG charts with hover tooltips', 'force-directed graph (d3-force)', 'light / dark themes · reduced motion']),
  arrow(740, 225, 810, 95, { accent: true }), arrow(810, 115, 740, 255, { accent: true }),
  arrow(210, 170, 210, 195), arrow(570, 170, 570, 195),
].join('\n'), 'Desktop application architecture');

for (const [name, content] of Object.entries(diagrams)) writeFileSync(join(OUT, `${name}.svg`), content);
console.log(`${Object.keys(diagrams).length} diagrams → ${OUT}`);
