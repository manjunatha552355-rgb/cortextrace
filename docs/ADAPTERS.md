# Adapters, custom agents and the local API

There are three ways to teach Cortextrace about an agent. Pick the lightest one that works.

| Approach | Effort | Gives you |
|---|---|---|
| **Custom agent (config)** | JSON in Settings, no code | process discovery, a hook endpoint with event-name mapping, per-agent policies |
| **Local API / OTLP** | a few lines in your agent | full structured events from inside the agent |
| **Built-in adapter (code)** | a PR | installer for the agent's native hooks, bespoke normalisation, approval responses |

## 1. Custom agents (no code)

Settings → Custom agents, or `custom_agents` in `config.json`:

```json
[{
  "id": "research-bot",
  "name": "Research Bot",
  "process_names": ["research-bot"],
  "command_line_regex": "python.*research_bot\\.py",
  "config_paths": ["/home/me/.research-bot/config.yaml"],
  "telemetry": ["process", "api"],
  "event_mappings": { "shell.run": "command_execution", "fs.write": "file_modified" },
  "capabilities": ["tool_calls"],
  "policies": [{
    "id": "rb-no-prod", "name": "Research Bot must not touch prod", "mode": "alert", "severity": "HIGH",
    "event_types": ["command_execution"], "conditions": [{ "field": "payload.command", "op": "contains", "value": "prod" }]
  }]
}]
```

- Matching processes and their descendants are tracked as agent `custom.research-bot`. Custom adapters win ties with built-ins.
- `POST /v1/hooks/custom.research-bot/shell.run` with `{"session_id":"…","cwd":"…","command":"ls"}` becomes a `command_execution` event. Payload keys such as `session_id`, `cwd`/`workspace`, `pid`, `correlation_id`, `tool_name` and `tool_input` are understood. Everything else is kept in `payload` after redaction.
- Policies listed on the agent apply only to that agent.

## 2. Local API

Tokens are in `tokens.json` in the data directory. `ingest` is write-only and `api` is read + manage. The full OpenAPI 3.1 document is at `GET /v1/openapi.json`.

```js
// examples/send-events.mjs
const token = JSON.parse(readFileSync(`${dataDir}/tokens.json`, 'utf8')).ingest;
await fetch('http://127.0.0.1:47631/v1/events', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  body: JSON.stringify([
    { event_type: 'session_started', agent_type: 'research-bot', session_id: 's1', workspace: process.cwd() },
    { event_type: 'tool_call', agent_type: 'research-bot', session_id: 's1', payload: { tool_name: 'web_search', arguments: { q: 'otel' } } },
    { event_type: 'command_execution', agent_type: 'research-bot', session_id: 's1', duration_ms: 120, payload: { command: 'git status' } },
  ]),
});
```

Rules and policies run on API events exactly as on hook events. Requests with an `Origin` header are rejected, so call the API from processes, not browsers.

### OpenTelemetry

Send OTLP/HTTP with **JSON** encoding to `http://127.0.0.1:4318/v1/{logs,traces,metrics}`. Protobuf is answered with `415`. Mapping:

- **Resource `service.name`** identifies the agent. Built-in adapters claim their names (`claude-code`, `codex_cli_rs`, `gemini-cli`, …). Anything else becomes `otel.<service>`.
- **Logs:** the event name (`event.name` attribute or body) suffix selects the type: `user_prompt` → prompt, `tool_decision` → approval granted/denied, `tool_result`/`tool_call` → tool/command/MCP events (shell tools with a command become `command_execution`), `api_request`/`api_response` → response metadata, `api_error` → error.
- **Traces:** spans with `gen_ai.tool.name` become tool events; other spans become response metadata with trace/span ids and duration.
- **Metrics:** summed per service/metric into the inventory (token usage, cost).

## 3. Writing a built-in adapter

Implement `AgentAdapter` (`src/adapters/types.ts`):

| Member | Purpose |
|---|---|
| `id`, `displayName`, `runtime`, `capabilities` | identity and capability declaration (shown in System Health) |
| `matchProcess(proc)` | identity detection from a live process; return `{confidence}` or `null`. Chromium `--type=` helper processes are never roots. |
| `installPaths(home)` | files/directories whose existence means "installed" |
| `otlpServiceNames?` | OTLP `service.name` values to claim |
| `normalizeHook?(eventName, payload)` | payload → `EventInput[]` (session detection, event normalisation) |
| `hookResponse?(eventName, decision)` | body the runtime expects when a `require_approval` policy matches |
| `integrations?`, `install?`, `uninstall?` | status and idempotent installation of hooks/telemetry. **Always back up first and remove only your own entries** (marker `src=cortextrace`). |
| `versionFrom?(proc)` | version detection |

Register it in `BUILTIN_ADAPTERS` (`src/adapters/builtin.ts`). Process-only agents take one line with the `simple()` helper:

```ts
simple('my-agent', 'My Agent', 'native cli', [{ names: ['my-agent'] }, { cmd: /my-agent[\\/]cli\.js/i, interpreters: NODE }], (h) => [join(h, '.my-agent')]),
```

Adapter code runs inside `registry.guard()`. If it throws, the failure is counted for that adapter only.

### Checklist for a new adapter PR

- [ ] unit test for `matchProcess` (positive and negative, including helper processes) in `tests/units.test.ts`
- [ ] normalisation test with a real captured payload (secrets removed) in `tests/engine.test.ts`
- [ ] install → reinstall → uninstall round-trip test that preserves user entries
- [ ] documentation row in `docs/INSTALL.md`
- [ ] never store file contents; drop large fields you don't need

## Writing detection rules

Add to `RULES` in `src/detection/rules.ts` with at least one `match` and one `no_match` example. The rule test suite runs them automatically. Prefer precise patterns with honest `confidence` over broad ones, and use `classification: 'observation'` for facts that are not suspicious in themselves.
