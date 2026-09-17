import { useState, type ReactNode } from 'react';
import type { PageProps } from '../App.tsx';
import { invoke, useQuery, SEVERITIES, agentName } from '../lib.ts';
import { Card, Switch, Segmented, AgentChip, Logo, Empty } from '../ui.tsx';

function Row({ label, desc, children }: { label: string; desc?: ReactNode; children: ReactNode }) {
  return <div className="form-row"><div><div>{label}</div>{desc && <div className="desc">{desc}</div>}</div><div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div></div>;
}

function NumberField({ value, onCommit, min, max, suffix }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; suffix?: string }) {
  const [v, setV] = useState(String(value));
  return <><input className="input num" style={{ width: 100 }} type="number" min={min} max={max} value={v} onChange={(e) => setV(e.target.value)} onBlur={() => { const n = Number(v); if (Number.isFinite(n) && n !== value) onCommit(n); }} />{suffix && <span className="muted">{suffix}</span>}</>;
}

function ListField({ value, onCommit, placeholder }: { value: string[]; onCommit: (v: string[]) => void; placeholder?: string }) {
  const [text, setText] = useState(value.join('\n'));
  return <textarea className="input" style={{ width: '100%', minHeight: 110 }} placeholder={placeholder} value={text} onChange={(e) => setText(e.target.value)} onBlur={() => onCommit(text.split('\n').map((s) => s.trim()).filter(Boolean))} spellCheck={false} />;
}

const TABS = [
  { id: 'general', label: 'General' }, { id: 'integrations', label: 'Integrations' }, { id: 'privacy', label: 'Privacy' },
  { id: 'detection', label: 'Detection & alerts' }, { id: 'data', label: 'Data' }, { id: 'custom', label: 'Custom agents' }, { id: 'about', label: 'About' },
];

export function SettingsPage({ route, nav }: PageProps) {
  const tab = route.params.tab ?? 'general';
  const { data, refetch } = useQuery<any>('config.get', null);
  const [error, setError] = useState<string | null>(null);
  if (!data) return <div className="muted">Loading…</div>;
  const c = data.config;
  const update = async (patch: unknown) => {
    try { await invoke('config.update', patch); setError(null); } catch (e) { setError((e as Error).message.replace(/^Error invoking remote method '[^']+': /, '')); }
    await refetch();
  };

  return (
    <div style={{ maxWidth: 980 }}>
      <div className="toolbar"><Segmented label="Settings section" value={tab} onChange={(t) => nav('settings', { tab: t })} options={TABS} /></div>
      {error && <div className="banner warn" style={{ margin: '0 0 12px' }}>Could not save: {error}</div>}
      {data.error && <div className="banner warn" style={{ margin: '0 0 12px' }}>{data.error}</div>}
      {tab === 'general' && (
        <Card title="General">
          <Row label="Appearance"><Segmented label="Theme" value={c.ui.theme} onChange={(v) => void update({ ui: { theme: v } })} options={[{ id: 'system', label: 'System' }, { id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }]} /></Row>
          <Row label="Start at login" desc="Launch minimized to the tray so monitoring runs in the background. (Linux: see docs/INSTALL.md.)"><Switch label="Start at login" checked={c.ui.start_on_login} onChange={(v) => void update({ ui: { start_on_login: v } })} /></Row>
          <Row label="Keep running in tray when window closes" desc="Monitoring continues; quit from the tray menu."><Switch label="Minimize to tray" checked={c.ui.minimize_to_tray} onChange={(v) => void update({ ui: { minimize_to_tray: v } })} /></Row>
          <Row label="Monitoring" desc="Pausing stops all collectors and discards incoming hook/OTLP events."><Switch label="Pause monitoring" checked={!c.monitoring.paused} onChange={(v) => void update({ monitoring: { paused: !v } })} /><span className="dim">{c.monitoring.paused ? 'Paused' : 'Active'}</span></Row>
          <Row label="Process discovery" desc="Reads the OS process list to identify running agents and the commands they spawn. No elevated privileges."><Switch label="Process discovery" checked={c.monitoring.process.enabled} onChange={(v) => void update({ monitoring: { process: { enabled: v } } })} /><NumberField value={c.monitoring.process.interval_ms / 1000} min={1} onCommit={(v) => void update({ monitoring: { process: { interval_ms: v * 1000 } } })} suffix="s interval" /></Row>
          <Row label="Network metadata" desc="Reads connection tables (remote address and port only, never contents) for monitored agent processes."><Switch label="Network metadata" checked={c.monitoring.network.enabled} onChange={(v) => void update({ monitoring: { network: { enabled: v } } })} /></Row>
          <Row label="Workspace file changes" desc="Watches directories of active agent sessions. Attribution is inferred, and events are marked as such."><Switch label="File watching" checked={c.monitoring.filesystem.enabled} onChange={(v) => void update({ monitoring: { filesystem: { enabled: v } } })} /><NumberField value={c.monitoring.filesystem.max_workspaces} min={0} max={128} onCommit={(v) => void update({ monitoring: { filesystem: { max_workspaces: v } } })} suffix="max workspaces" /></Row>
        </Card>
      )}
      {tab === 'integrations' && <IntegrationsTab data={data} update={update} />}
      {tab === 'privacy' && (
        <Card title="Privacy" sub="everything stays on this device unless you configure an export">
          <Row label="Prompts" desc="Metadata keeps length and a short hash. Detection still scans prompt text in memory before it is discarded.">
            <Segmented label="Prompt retention" value={c.privacy.prompts} onChange={(v) => void update({ privacy: { prompts: v } })} options={[{ id: 'metadata', label: 'Metadata only' }, { id: 'redacted', label: 'Redacted text' }, { id: 'full', label: 'Full text' }]} />
          </Row>
          <Row label="Tool output" desc="Redacted keeps the first 2 KB after secret redaction."><Segmented label="Tool output retention" value={c.privacy.tool_output} onChange={(v) => void update({ privacy: { tool_output: v } })} options={[{ id: 'metadata', label: 'Metadata only' }, { id: 'redacted', label: 'Redacted, truncated' }]} /></Row>
          <Row label="Command lines" desc="Metadata keeps the binary name and argument count only."><Segmented label="Command line retention" value={c.privacy.command_lines} onChange={(v) => void update({ privacy: { command_lines: v } })} options={[{ id: 'redacted', label: 'Redacted' }, { id: 'metadata', label: 'Binary only' }]} /></Row>
          <div className="section-title">Always applied</div>
          <ul className="dim" style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
            <li>Secret redaction for API keys, tokens, private keys, JWTs, credentials in URLs and assigned secrets, before anything is stored.</li>
            <li>File contents are never stored. MCP server environment variable values are never read into storage.</li>
            <li>No telemetry, account or network access by default. The local API listens on 127.0.0.1 only and requires tokens.</li>
            <li>Database, tokens and config files are created readable by your user only (POSIX); on Windows they live in your profile.</li>
          </ul>
          <div className="section-title">Custom redaction patterns</div>
          <div className="dim" style={{ fontSize: 12, marginBottom: 6 }}>One per line as <span className="mono">label=regex</span>, for example <span className="mono">employee_id=EMP-\d{'{6}'}</span>.</div>
          <ListField value={c.privacy.custom_patterns.map((p: any) => `${p.label}=${p.regex}`)} onCommit={(lines) => void update({ privacy: { custom_patterns: lines.filter((l) => l.includes('=')).map((l) => ({ label: l.slice(0, l.indexOf('=')), regex: l.slice(l.indexOf('=') + 1) })) } })} />
        </Card>
      )}
      {tab === 'detection' && (
        <>
          <Card title="Risk thresholds" sub="score boundaries for levels">
            {(['low', 'medium', 'high', 'critical'] as const).map((k) => (
              <Row key={k} label={k[0]!.toUpperCase() + k.slice(1)}><NumberField value={c.risk.thresholds[k]} min={0} max={100} onCommit={(v) => void update({ risk: { thresholds: { [k]: v } } })} suffix="and above" /></Row>
            ))}
          </Card>
          <div style={{ height: 14 }} />
          <Card title="Behavioral detection">
            <Row label="Mass file modification" desc="File changes by one session within the window."><NumberField value={c.detection.mass_file_threshold} min={5} onCommit={(v) => void update({ detection: { mass_file_threshold: v } })} suffix="changes in" /><NumberField value={c.detection.mass_file_window_sec} min={5} onCommit={(v) => void update({ detection: { mass_file_window_sec: v } })} suffix="seconds" /></Row>
            <Row label="Activity anomaly" desc="Standard deviations above an agent type's learned events-per-minute baseline."><NumberField value={c.detection.anomaly_z} min={1} onCommit={(v) => void update({ detection: { anomaly_z: v } })} suffix="σ" /></Row>
            <Row label="Network allowlist" desc="Destinations never flagged as unexpected. Wildcards like *.example.com."><ListField value={c.detection.network_allowlist} onCommit={(v) => void update({ detection: { network_allowlist: v } })} /></Row>
            <Row label="Known MCP servers" desc="In addition to servers found in agent configuration files."><ListField value={c.detection.known_mcp_servers} onCommit={(v) => void update({ detection: { known_mcp_servers: v } })} placeholder="github" /></Row>
          </Card>
          <div style={{ height: 14 }} />
          <Card title="Alerts">
            <Row label="Create alerts at" desc="Detections below this severity are recorded but do not create alerts."><select className="input" value={c.alerts.min_severity} onChange={(e) => void update({ alerts: { min_severity: e.target.value } })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select></Row>
            <Row label="Desktop notifications"><Switch label="Desktop notifications" checked={c.alerts.desktop_notifications} onChange={(v) => void update({ alerts: { desktop_notifications: v } })} /><span className="muted">for</span><select className="input" value={c.alerts.notify_min_severity} onChange={(e) => void update({ alerts: { notify_min_severity: e.target.value } })}>{SEVERITIES.map((s) => <option key={s}>{s}</option>)}</select><span className="muted">and above</span></Row>
            <Row label="Deduplication window" desc="Identical alerts within the window increase a counter instead of notifying again."><NumberField value={c.alerts.dedup_window_sec} min={0} onCommit={(v) => void update({ alerts: { dedup_window_sec: v } })} suffix="seconds" /></Row>
            <Row label="Webhook" desc="Optional. Sends alert metadata (never prompts, payloads or file contents) to this URL, e.g. a SIEM or chat integration.">
              <WebhookField value={c.alerts.webhook_url} onCommit={(v) => void update({ alerts: { webhook_url: v } })} />
            </Row>
            <Row label="Suppressions" desc="Alerts from these rules are stored as suppressed.">
              {c.alerts.suppressions.length === 0 ? <span className="muted">None</span> : c.alerts.suppressions.map((s: any, i: number) => (
                <span key={i} className="badge">{s.rule_id}{s.agent_type ? ` · ${agentName(s.agent_type)}` : ''}<button className="btn ghost sm" style={{ height: 16, padding: '0 3px' }} aria-label="Remove suppression" onClick={() => void update({ alerts: { suppressions: c.alerts.suppressions.filter((_: any, j: number) => j !== i) } })}>×</button></span>
              ))}
            </Row>
          </Card>
        </>
      )}
      {tab === 'data' && (
        <Card title="Data">
          <Row label="Retention" desc="Older events, detections and closed alerts are deleted hourly."><NumberField value={c.retention.days} min={1} onCommit={(v) => void update({ retention: { days: v } })} suffix="days" /></Row>
          <Row label="Maximum stored events"><NumberField value={c.retention.max_events} min={10000} onCommit={(v) => void update({ retention: { max_events: v } })} suffix="events" /></Row>
          <Row label="Export events"><button className="btn" onClick={() => void invoke('export.events', { query: {}, format: 'jsonl' })}>All events (JSONL)</button><button className="btn" onClick={() => void invoke('export.events', { query: {}, format: 'csv' })}>All events (CSV)</button></Row>
          <Row label="OpenTelemetry export" desc="Optional. Forwards normalized events as OTLP/HTTP JSON logs to your collector (off by default).">
            <WebhookField value={c.export.otlp_endpoint} placeholder="http://collector.internal:4318" onCommit={(v) => void update({ export: { otlp_endpoint: v } })} />
          </Row>
          <Row label="Data directory"><span className="mono dim">{data.data_dir}</span><button className="btn sm" onClick={() => void invoke('open.dataDir')}>Open</button></Row>
          <Row label="Diagnostics" desc="Health, collector state and config. Contains no events, prompts or tokens."><button className="btn" onClick={() => void invoke('export.diagnostics')}>Export diagnostics bundle</button></Row>
        </Card>
      )}
      {tab === 'custom' && <CustomAgentsTab agents={c.custom_agents} update={update} />}
      {tab === 'about' && (
        <Card title="About">
          <div style={{ display: 'flex', gap: 14, alignItems: 'center', marginBottom: 12 }}><Logo size={48} /><div><div style={{ fontSize: 17, fontWeight: 650 }}>Cortextrace</div><div className="dim">Version {data.version} · {data.platform} · Apache-2.0</div></div></div>
          <p className="dim">Local-first observability and threat detection for AI agents. Cortextrace watches what agents do on this machine and explains the risk. It does not hide from the user, does not bypass OS security boundaries, and does not send data anywhere unless you configure an export.</p>
          <p className="dim">Third-party components and their licenses are listed in THIRD_PARTY_NOTICES.md in the installation directory.</p>
        </Card>
      )}
    </div>
  );
}

function WebhookField({ value, onCommit, placeholder = 'https://…' }: { value: string | null; onCommit: (v: string | null) => void; placeholder?: string }) {
  const [v, setV] = useState(value ?? '');
  return <input className="input" style={{ width: 380 }} value={v} placeholder={placeholder} onChange={(e) => setV(e.target.value)} onBlur={() => { const t = v.trim(); if ((t || null) !== value) onCommit(t || null); }} />;
}

function IntegrationsTab({ data, update }: { data: any; update: (p: unknown) => Promise<void> }) {
  const { data: integrations, refetch } = useQuery<any[]>('integrations', null);
  const [msg, setMsg] = useState<string | null>(null);
  const toggle = async (i: any) => {
    try {
      const r = await invoke<any>('integration.set', { adapter_id: i.adapter_id, integration_id: i.id, install: !i.installed });
      setMsg(`${i.label}: ${r.message}${r.backup ? ` (backup: ${r.backup})` : ''}`);
    } catch (e) {
      setMsg((e as Error).message);
    }
    await refetch();
  };
  return (
    <>
      <Card title="Agent integrations" sub="hooks and OpenTelemetry give full tool, command and file detail">
        <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
          Enabling an integration edits that agent's own configuration file, after saving a backup next to it. Hooks call the local API with a write-only token and time out after 3 seconds; if Cortextrace is not running the agent continues normally. Restart the agent after changing integrations.
        </div>
        {msg && <div className="banner" style={{ margin: '0 0 10px' }}>{msg}</div>}
        {!data.api_port && <div className="banner warn" style={{ margin: '0 0 10px' }}>The local API is not listening, so hook integrations cannot deliver events. See System Health.</div>}
        <table className="table">
          <thead><tr><th>Agent</th><th>Integration</th><th>Config file</th><th>Status</th><th /></tr></thead>
          <tbody>
            {(integrations ?? []).map((i) => (
              <tr key={i.adapter_id + i.id}>
                <td><AgentChip type={i.adapter_id} /></td>
                <td>{i.kind === 'hooks' ? 'Hooks' : 'OpenTelemetry'}</td>
                <td className="mono dim ellipsis" style={{ maxWidth: 300 }} title={i.file}>{i.file}</td>
                <td className="dim">{i.installed ? <span className="chip"><span className="dot" />{i.detail}</span> : i.detail}</td>
                <td style={{ textAlign: 'right' }}><button className={`btn sm ${i.installed ? '' : 'primary'}`} onClick={() => void toggle(i)}>{i.installed ? 'Remove' : 'Enable'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <div style={{ height: 14 }} />
      <Card title="Endpoints" sub="for any agent that can send hooks, OTLP or JSON events">
        <Row label="Local API" desc="Bearer-token authenticated. Tokens are in tokens.json in the data directory."><span className="mono">{data.api_port ? `http://127.0.0.1:${data.api_port}` : 'not listening'}</span></Row>
        <Row label="OTLP/HTTP receiver" desc="JSON encoding (set protocol to http/json). Loopback only.">
          <span className="mono">{data.otlp_port ? `http://127.0.0.1:${data.otlp_port}` : 'not listening'}</span>
          <Switch label="OTLP receiver" checked={data.config.monitoring.otlp.enabled} onChange={(v) => void update({ monitoring: { otlp: { enabled: v } } })} />
        </Row>
        <Row label="API reference" desc="OpenAPI 3.1 document"><span className="mono">GET /v1/openapi.json</span></Row>
      </Card>
    </>
  );
}

const CUSTOM_TEMPLATE = [{
  id: 'research-bot', name: 'Research Bot', process_names: ['research-bot'], command_line_regex: 'python.*research_bot\\.py',
  config_paths: ['~/.research-bot/config.yaml'], telemetry: ['process', 'api'], event_mappings: { 'shell.run': 'command_execution', 'fs.write': 'file_modified' },
  capabilities: ['tool_calls'], policies: [],
}];

function CustomAgentsTab({ agents, update }: { agents: any[]; update: (p: unknown) => Promise<void> }) {
  const [text, setText] = useState(JSON.stringify(agents.length ? agents : [], null, 2));
  const [err, setErr] = useState<string | null>(null);
  return (
    <Card title="Custom agents" sub="identify in-house or unlisted agents" right={<button className="btn sm" onClick={() => setText(JSON.stringify(CUSTOM_TEMPLATE, null, 2))}>Insert example</button>}>
      <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Each entry becomes an adapter with id <span className="mono">custom.&lt;id&gt;</span>. Processes matching a name or command-line regex are tracked like built-in agents. Send events to <span className="mono">POST /v1/hooks/custom.&lt;id&gt;/&lt;event&gt;</span>; <span className="mono">event_mappings</span> translates your event names into Cortextrace event types. Policies listed here apply only to this agent. See docs/ADAPTERS.md.
      </div>
      {agents.length === 0 && text === '[]' && <Empty title="No custom agents" />}
      <textarea className="input" style={{ width: '100%', minHeight: 360 }} value={text} onChange={(e) => { setText(e.target.value); setErr(null); }} spellCheck={false} aria-label="Custom agents JSON" />
      {err && <div className="banner warn" style={{ margin: '8px 0 0' }}>{err}</div>}
      <div style={{ marginTop: 8 }}><button className="btn primary" onClick={async () => { try { await update({ custom_agents: JSON.parse(text) }); } catch (e) { setErr((e as Error).message); } }}>Save custom agents</button></div>
    </Card>
  );
}

export function Onboarding({ cfg, done }: { cfg: any; done: () => Promise<void> }) {
  const [step, setStep] = useState(0);
  const { data: agents } = useQuery<any[]>('agents', null, { interval: 4000 });
  const { data: integrations, refetch } = useQuery<any[]>('integrations', null);
  const [startOnLogin, setStartOnLogin] = useState(cfg.config.ui.start_on_login);
  const found = (agents ?? []).filter((a) => a.installed || a.running);
  const relevant = (integrations ?? []).filter((i) => found.some((a) => a.agent_type === i.adapter_id));

  return (
    <div className="content" style={{ height: '100%' }}>
      <div className="onboard">
        <div className="steps">{[0, 1, 2].map((i) => <span key={i} className={i <= step ? 'on' : ''} />)}</div>
        {step === 0 && (
          <>
            <Logo size={52} />
            <h2 style={{ marginTop: 16 }}>See what AI agents are doing on this computer.</h2>
            <p>Cortextrace discovers coding agents and AI tools, records their commands, file changes, tool and MCP calls, and flags risky behavior with an explanation. Here is exactly what it monitors:</p>
            <div className="check-list">
              {[
                ['Process list', 'Names and command lines of agent processes and the processes they start. Secrets in command lines are redacted.'],
                ['Network metadata', 'Remote address and port of connections opened by agent processes. Never traffic contents.'],
                ['Workspace file changes', 'Paths and sizes of files changed in active agent workspaces. Never file contents.'],
                ['Agent hooks & telemetry (opt-in)', 'Tool calls, commands and prompts reported by agents you connect in the next step. Prompts are stored as metadata only by default.'],
              ].map(([t, d]) => <div key={t} className="check-item"><span className="dot" style={{ marginTop: 5 }} /><div><strong>{t}</strong><div className="dim">{d}</div></div></div>)}
            </div>
            <p>Everything stays on this device. There is no account and no cloud upload. You can pause monitoring at any time from the sidebar or tray.</p>
            <button className="btn primary" onClick={() => setStep(1)}>Continue</button>
          </>
        )}
        {step === 1 && (
          <>
            <h2>Agents found on this machine</h2>
            <p>Detected from running processes and known configuration locations. Connect integrations for full detail; each one edits that agent's config after making a backup.</p>
            <div className="check-list">
              {found.length === 0 && <div className="check-item"><div className="dim">No known agents detected yet. Discovery keeps running; you can connect integrations later in Settings.</div></div>}
              {found.map((a) => (
                <div key={a.agent_id} className="check-item" style={{ alignItems: 'center' }}>
                  <AgentChip type={a.agent_type} />
                  <span className="muted">{a.running ? 'running' : 'installed'}</span>
                  <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
                    {relevant.filter((i) => i.adapter_id === a.agent_type).map((i) => (
                      <button key={i.id} className={`btn sm ${i.installed ? '' : 'primary'}`} onClick={async () => { await invoke('integration.set', { adapter_id: i.adapter_id, integration_id: i.id, install: !i.installed }); await refetch(); }}>
                        {i.installed ? `✓ ${i.kind === 'hooks' ? 'Hooks' : 'Telemetry'} connected` : `Connect ${i.kind === 'hooks' ? 'hooks' : 'telemetry'}`}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}><button className="btn" onClick={() => setStep(0)}>Back</button><button className="btn primary" onClick={() => setStep(2)}>Continue</button></div>
          </>
        )}
        {step === 2 && (
          <>
            <h2>Background monitoring</h2>
            <p>Closing the window keeps Cortextrace running in the {navigator.platform.startsWith('Mac') ? 'menu bar' : 'system tray'}, with desktop notifications for high and critical alerts.</p>
            <div className="check-item" style={{ alignItems: 'center', marginBottom: 16 }}>
              <Switch label="Start at login" checked={startOnLogin} onChange={setStartOnLogin} /><div><strong>Start at login</strong><div className="dim">Recommended so agent activity is captured from the start of your day.</div></div>
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" onClick={() => setStep(1)}>Back</button>
              <button className="btn primary" onClick={async () => { await invoke('config.update', { ui: { start_on_login: startOnLogin } }); await done(); }}>Open dashboard</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
