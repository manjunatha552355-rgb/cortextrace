// Prepares an isolated, personal-data-free demo environment for documentation screenshots.
// Everything here is sample configuration; nothing is executed except harmless sleeping child processes.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DEMO = 'F:\\CortextraceDemo';
const home = join(DEMO, 'home');
const w = (p, s) => { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, typeof s === 'string' ? s : JSON.stringify(s, null, 2)); };

export function setup(apiPort) {
  w(join(home, '.claude', 'settings.json'), { model: 'sonnet' });
  w(join(home, '.claude.json'), {
    mcpServers: { github: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_PERSONAL_ACCESS_TOKEN: 'demo-placeholder' } } },
    projects: { '/home/dev/projects/payments-api': { mcpServers: { postgres: { command: 'uvx', args: ['postgres-mcp', '--readonly'] } } } },
  });
  w(join(home, '.cursor', 'mcp.json'), { mcpServers: { linear: { url: 'https://mcp.linear.app/sse' }, filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', '/home/dev/projects'] } } });
  w(join(home, '.codex', 'config.toml'), 'model = "gpt-5-codex"\n\n[mcp_servers.docs]\ncommand = "npx"\nargs = ["-y", "docs-mcp"]\n');
  w(join(home, '.gemini', 'settings.json'), { theme: 'Default' });
  w(join(home, 'AppData', 'Roaming', 'Claude', 'claude_desktop_config.json'), { mcpServers: { memory: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'] } } });

  w(join(DEMO, 'data', 'config.json'), {
    api: { port: apiPort },
    monitoring: { otlp: { port: apiPort + 1 }, process: { enabled: false }, network: { enabled: false }, filesystem: { enabled: false } },
    ui: { theme: 'light', minimize_to_tray: false, onboarded: false },
    detection: { known_mcp_servers: ['github', 'linear', 'filesystem', 'postgres', 'memory', 'docs'] },
    custom_agents: [{ id: 'research-bot', name: 'Research Bot', process_names: ['research-bot'], telemetry: ['process', 'api'], event_mappings: { 'shell.run': 'command_execution' }, capabilities: ['tool_calls'], policies: [] }],
    policies: [
      { id: 'sensitive-directories', name: 'Access to sensitive directories', mode: 'alert', severity: 'HIGH', dimension: 'credential', description: 'Flags any agent access to SSH, cloud, GPG and Kubernetes credential directories.', event_types: ['file_read', 'file_modified', 'file_created', 'file_deleted', 'directory_access'], conditions: [{ field: 'payload.path', op: 'glob', value: ['**/.ssh/**', '**/.aws/**', '**/.gnupg/**', '**/.kube/**'] }] },
      { id: 'destructive-commands', name: 'Destructive shell commands', mode: 'alert', severity: 'MEDIUM', dimension: 'command', description: 'Recursive force deletes and force pushes require a human to confirm.', event_types: ['command_execution'], conditions: [{ field: 'payload.command', op: 'matches', value: ['\\brm\\s+-[a-z]*r[a-z]*f', 'git\\s+push\\s+.*(--force|-f\\b)'] }] },
      { id: 'package-installation', name: 'Package installation', mode: 'observe', severity: 'LOW', dimension: 'command', description: 'Records dependency installs so supply-chain changes are reviewable.', event_types: ['command_execution'], conditions: [{ field: 'payload.command', op: 'matches', value: ['\\b(npm|pnpm|yarn)\\s+(add|install|i)\\s+[@\\w]', '\\bpip3?\\s+install\\s+[\\w-]'] }] },
      { id: 'prod-deploy-approval', name: 'Production deploys require approval', mode: 'require_approval', severity: 'HIGH', dimension: 'policy', description: 'Agents must get human approval before deploying to production.', event_types: ['command_execution'], conditions: [{ field: 'payload.command', op: 'contains', value: 'deploy --prod' }] },
    ],
  });

  // Demo agent process tree (matched by the Node.js agent framework signature via its file name).
  w(join(DEMO, 'agents', 'langchain_research_agent.mjs'), `import { spawn } from 'node:child_process';
const tool = (name, ...args) => spawn(process.execPath, [new URL('./tools/' + name, import.meta.url).pathname.slice(1), ...args], { stdio: 'ignore' });
tool('web_search_tool.mjs', '--query', 'opentelemetry genai conventions');
tool('summarize_tool.mjs', '--max-tokens', '800');
setInterval(() => {}, 1 << 30);
`);
  w(join(DEMO, 'agents', 'tools', 'web_search_tool.mjs'), `import { spawn } from 'node:child_process';
spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 3e6)', 'http-fetch-worker'], { stdio: 'ignore' });
setInterval(() => {}, 1 << 30);
`);
  w(join(DEMO, 'agents', 'tools', 'summarize_tool.mjs'), 'setInterval(() => {}, 1 << 30);\n');
}
