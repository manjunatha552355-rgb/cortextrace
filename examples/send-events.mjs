// Minimal client for the Cortextrace local API. Run while Cortextrace is running:
//   node examples/send-events.mjs [data-dir]
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const dataDir = process.argv[2] ?? (process.platform === 'win32'
  ? join(process.env.APPDATA, 'Cortextrace')
  : process.platform === 'darwin' ? join(homedir(), 'Library/Application Support/Cortextrace') : join(homedir(), '.config/Cortextrace'));
const { ingest } = JSON.parse(readFileSync(join(dataDir, 'tokens.json'), 'utf8'));
const config = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'));
const base = `http://127.0.0.1:${config.api?.port ?? 47631}`;

const session = `example-${Date.now()}`;
const res = await fetch(`${base}/v1/events`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${ingest}` },
  body: JSON.stringify([
    { event_type: 'session_started', agent_type: 'example-agent', session_id: session, workspace: process.cwd() },
    { event_type: 'tool_call', agent_type: 'example-agent', session_id: session, payload: { tool_name: 'web_search', arguments: { q: 'opentelemetry genai' } } },
    { event_type: 'command_execution', agent_type: 'example-agent', session_id: session, duration_ms: 42, payload: { command: 'git status' } },
    { event_type: 'session_completed', agent_type: 'example-agent', session_id: session },
  ]),
});
console.log(res.status, await res.json());
