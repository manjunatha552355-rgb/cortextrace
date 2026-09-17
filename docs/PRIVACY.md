# Privacy

Cortextrace is local-first. **With default settings nothing is sent off the device, and no account is needed.**

## What is collected, and from where

| Source | Collected | Never collected | Can disable |
|---|---|---|---|
| Process list | process name, executable path, command line (secrets redacted), pid/ppid, start time, for agent processes and their descendants | processes unrelated to agents are identified but not stored | Settings → General → Process discovery |
| Connection tables | remote IP, port, resolved LLM API hostname, pid, for monitored agent processes | payloads, DNS queries, traffic from other apps | Settings → General → Network metadata |
| Workspace file watching | path, size, created/modified/deleted | file contents | Settings → General → Workspace file changes |
| Agent hooks (opt-in per agent) | tool name, command, file path, MCP server/tool, prompt length + hash | file contents from read hooks (discarded on arrival) | remove integration |
| OTLP from agents | event names, tool names/durations, token counts, cost | prompts (Cortextrace configures agents with prompt logging **off**) | Settings → Integrations |
| MCP configuration files | server names, transport, command/URL (redacted), names of env vars | env var values | n/a (read-only scan) |

## Retention modes

| Data | Default | Options |
|---|---|---|
| Prompts | **metadata** (length + 16-hex SHA-256 prefix) | redacted text, full text |
| Tool output | **metadata** (length) | redacted and truncated to 2 KB |
| Command lines | **redacted** | binary name + argument count only |
| Event retention | 30 days, max 5M events | configurable |

Detection runs on content *before* minimisation. For example, a prompt-injection phrase can be flagged even though the prompt itself isn't kept. Detection evidence stores only a short snippet around the match.

## Redaction

Applied to every string in every payload before storage: private keys, AWS access keys, GitHub/GitLab-style tokens, Anthropic and OpenAI keys, Google API keys, Slack tokens, Stripe live keys, JWTs, bearer tokens, credentials embedded in URLs, and `password=…`/`token: …`-style assignments. Sensitive JSON keys (`authorization`, `cookie`, `password`, `api_key`, `client_secret`, …) are masked whole. You can add your own patterns in Settings → Privacy.

## Where data lives

| OS | Directory |
|---|---|
| Windows | `%APPDATA%\Cortextrace` |
| macOS | `~/Library/Application Support/Cortextrace` |
| Linux | `~/.config/Cortextrace` |

Files: `cortextrace.db` (SQLite), `config.json`, `tokens.json`, `alerts.jsonl`, `logs/`. On POSIX they are created with mode 0600. The database is not encrypted at rest; rely on OS full-disk encryption (BitLocker, FileVault, LUKS). This is a known limitation, and SQLCipher support is on the roadmap.

## Outbound network activity

With defaults, **none**, apart from the periodic DNS lookups that map LLM API hostnames to IPs for network attribution. Outbound connections are made only when you configure one of these:

- an alert **webhook**: alert metadata only (rule, severity, reason, evidence snippet, agent, session id);
- an **OTLP export endpoint**: normalised, already-redacted and minimised events.

## User control

- Pause monitoring from the sidebar or tray at any time. While paused, all incoming data is discarded.
- Delete data: remove the data directory, or lower retention and click *Apply retention*.
- Export everything you have: JSONL or CSV.
