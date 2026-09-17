# Event schema (v1)

Every observation becomes one `AgentEvent`. The zod schema in `src/core/schema.ts` is the source of truth.

| Field | Type | Notes |
|---|---|---|
| `event_id` | string | UUID v4 |
| `event_version` | int | schema version, currently `1` |
| `timestamp` | int | epoch milliseconds (OTLP nanoseconds are truncated) |
| `host_id` | string | first 16 hex chars of SHA-256(hostname) |
| `agent_id` | string | `<agent_type>@<host_id>` |
| `agent_type` | string | adapter id: `claude-code`, `cursor`, `custom.<id>`, `otel.<service>` … |
| `agent_version` | string \| null | when reported (OTLP `service.version`, API) |
| `session_id` | string \| null | runtime session id, or `proc:<adapter>:<pid>:<start>` for process-derived sessions |
| `process_id`, `parent_process_id` | int \| null | |
| `workspace` | string \| null | working directory where known |
| `event_type` | enum | see below |
| `source` | enum | `hook` `otlp` `process` `network` `filesystem` `config` `api` `synthetic` `engine` |
| `fidelity` | `observed` \| `inferred` | *inferred* = attributed by correlation (file watching, LLM-API-based discovery) |
| `severity` | `INFO` `LOW` `MEDIUM` `HIGH` `CRITICAL` | raised to the highest detection on the event |
| `duration_ms` | number \| null | tool/command duration where reported or derived from correlated pre/post hooks |
| `payload` | object | type-specific, redacted, minimised per privacy settings |
| `correlation_id` | string \| null | tool call id, or for detection events the triggering event id |
| `trace_id`, `span_id`, `parent_span_id` | string \| null | OpenTelemetry identifiers when available |
| `risk_score` | 0–100 | event-level risk from its detections |
| `security_labels` | string[] | redaction labels (`github_token`, …) and matched rule ids |

## Event types

`agent_started` `agent_stopped` `session_started` `session_completed` `prompt_observed` `response_metadata` `tool_call` `tool_result` `command_execution` `process_started` `process_exited` `file_created` `file_modified` `file_deleted` `file_read` `directory_access` `network_connection_metadata` `mcp_call` `mcp_server_activity` `approval_requested` `approval_granted` `approval_denied` `authentication_event` `error` `warning` `security_detection` `policy_violation`

## Common payload keys

| Event | Keys |
|---|---|
| `command_execution` | `command`, `tool_name`, `cwd`, `executable`, `parent_name`, `success`, `exit_code`, `observed_via` |
| `file_*` / `directory_access` | `path`, `operation`, `size`, `content_length`, `relative_path`, `pattern` |
| `network_connection_metadata` | `remote_ip`, `remote_port`, `host`, `url`, `loopback`, `direction`, `process_name`, `via` |
| `mcp_call` | `mcp_server`, `mcp_tool`, `tool_name`, `arguments` |
| `tool_result` | `tool_name`, `success`, `error`, `output_length`, `output` (only in *redacted* mode) |
| `prompt_observed` | `prompt_length`, `prompt_sha256`, `prompt` (only in *redacted*/*full* mode) |
| `response_metadata` | `model`, `input_tokens`, `output_tokens`, `cost_usd`, … |
| `security_detection` / `policy_violation` | `detection_id`, `rule_id`, `rule_name`, `reason`, `evidence`, `classification`, `confidence` |

## Versioning and compatibility

- Additive changes (new optional fields, new payload keys, new event types) do not bump `event_version`.
- Breaking changes bump `event_version`. Stored rows keep their version. `upgradeEvent()` in `schema.ts` upgrades old shapes on read, so callers only ever see the current shape.
- A reader refuses events from a *newer* schema version rather than misinterpreting them.
- Database schema changes are appended to `MIGRATIONS` in `storage/db.ts` and tracked with `PRAGMA user_version`.

## Storage mapping

Indexed columns: `ts`, `(session_id, ts)`, `(agent_id, ts)`, `(event_type, ts)`, `(agent_type, ts)`, `(workspace, ts)`, `(tool, ts)`, `(event_type, summary, ts)`, `correlation_id`. `payload` and `labels` are stored as JSON text. `summary` is a short human-readable string (command, path, destination, tool) used for search and top-N views.
