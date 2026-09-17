import { useMemo, useState } from 'react';
import type { PageProps } from '../App.tsx';
import { invoke, useQuery, fmtAgo, fmtDateTime, DIM_LABEL, SEVERITIES, sevRank, agentName } from '../lib.ts';
import { Card, Stat, SevBadge, AgentChip, Empty, SearchInput, Segmented, Switch, Drawer } from '../ui.tsx';
import { BarList } from '../charts.tsx';
import { DetectionDrawer } from './agents.tsx';
import type { Detection, Severity } from '../../core/schema.ts';

export function ThreatsPage({ nav, from, route }: PageProps) {
  const [view, setView] = useState<'alerts' | 'detections'>('alerts');
  const [status, setStatus] = useState<'open' | 'acknowledged' | 'suppressed' | 'all'>('open');
  const [minSev, setMinSev] = useState<Severity>('LOW');
  const [search, setSearch] = useState(route.params.rule ?? '');
  const [classFilter, setClassFilter] = useState('all');
  const [openDet, setOpenDet] = useState<Detection | null>(null);
  const alertsQ = useQuery<any[]>('alerts', { from, status: status === 'all' ? undefined : status }, { interval: 5000 });
  const detsQ = useQuery<Detection[]>('detections', { from, min_severity: minSev, limit: 2000 }, { interval: 5000 });
  const dets = detsQ.data ?? [];

  const incidents = useMemo(() => {
    const q = search.toLowerCase();
    const m = new Map<string, any[]>();
    for (const a of alertsQ.data ?? []) {
      if (sevRank(a.severity) < sevRank(minSev)) continue;
      if (q && !a.title.toLowerCase().includes(q) && !a.rule_id.includes(q) && !agentName(a.agent_type).toLowerCase().includes(q)) continue;
      const arr = m.get(a.incident_id);
      if (arr) arr.push(a); else m.set(a.incident_id, [a]);
    }
    return [...m.entries()].map(([id, alerts]) => ({ id, alerts, top: alerts.reduce((x, y) => (sevRank(y.severity) > sevRank(x.severity) ? y : x)), last: Math.max(...alerts.map((a) => a.last_ts)) }))
      .sort((a, b) => sevRank(b.top.severity) - sevRank(a.top.severity) || b.last - a.last);
  }, [alertsQ.data, minSev, search]);

  const filteredDets = useMemo(() => {
    const q = search.toLowerCase();
    return dets.filter((d) => (classFilter === 'all' || d.classification === classFilter) && (!q || d.rule_name.toLowerCase().includes(q) || d.rule_id.includes(q) || d.evidence.join(' ').toLowerCase().includes(q)));
  }, [dets, classFilter, search]);

  const setAlert = async (id: string, s: string) => { await invoke('alert.status', { alert_id: id, status: s }); await alertsQ.refetch(); };
  const openAlert = async (a: any) => {
    const d = dets.find((x) => x.detection_id === a.detection_id) ?? (await invoke<Detection[]>('detections', { session_id: a.session_id, limit: 2000 })).find((x) => x.detection_id === a.detection_id);
    if (d) setOpenDet(d);
  };
  const sevCount = (s: Severity) => dets.filter((d) => d.severity === s).length;
  const dimCounts = Object.entries(dets.reduce<Record<string, number>>((acc, d) => { if (d.severity !== 'INFO') acc[d.dimension] = (acc[d.dimension] ?? 0) + 1; return acc; }, {})).map(([key, n]) => ({ key, n })).sort((a, b) => b.n - a.n);

  return (
    <div className="grid" style={{ gap: 14 }}>
      <div className="stats">
        <Stat label="Open incidents" value={incidents.length} />
        <Stat label="Critical" value={sevCount('CRITICAL')} tone="CRITICAL" />
        <Stat label="High" value={sevCount('HIGH')} tone="HIGH" />
        <Stat label="Medium" value={sevCount('MEDIUM')} tone="MEDIUM" />
        <Stat label="Low" value={sevCount('LOW')} tone="LOW" />
        <Stat label="Policy violations" value={dets.filter((d) => d.classification === 'policy_violation').length} />
      </div>
      <div className="grid cols-4" style={{ alignItems: 'start' }}>
        <div className="span-3">
          <div className="toolbar">
            <Segmented label="View" value={view} onChange={setView} options={[{ id: 'alerts', label: 'Incidents' }, { id: 'detections', label: 'All detections' }]} />
            {view === 'alerts'
              ? <Segmented label="Status" value={status} onChange={setStatus} options={[{ id: 'open', label: 'Open' }, { id: 'acknowledged', label: 'Acknowledged' }, { id: 'suppressed', label: 'Suppressed' }, { id: 'all', label: 'All' }]} />
              : <Segmented label="Classification" value={classFilter} onChange={setClassFilter} options={[{ id: 'all', label: 'All' }, { id: 'policy_violation', label: 'Violations' }, { id: 'suspicious_indicator', label: 'Indicators' }, { id: 'observation', label: 'Observations' }]} />}
            <select className="input" value={minSev} onChange={(e) => setMinSev(e.target.value as Severity)} aria-label="Minimum severity">
              {SEVERITIES.map((s) => <option key={s} value={s}>{s === 'INFO' ? 'All severities' : `${s} and above`}</option>)}
            </select>
            <SearchInput value={search} onChange={setSearch} placeholder="Rule, agent or evidence" />
          </div>
          {view === 'alerts' ? (
            incidents.length === 0 ? <div className="card"><Empty title="No incidents">Alerts at or above the alerting threshold are grouped here by session.</Empty></div> : incidents.map((inc) => (
              <div className="card" key={inc.id} style={{ marginBottom: 10 }}>
                <div className="card-h">
                  <SevBadge s={inc.top.severity} />
                  <h3>{inc.top.title}{inc.alerts.length > 1 && <span className="muted"> + {inc.alerts.length - 1} related</span>}</h3>
                  <span className="sub">{fmtAgo(inc.last)}</span>
                  <div className="right">
                    <AgentChip type={inc.top.agent_type} />
                    {inc.top.session_id && <button className="btn sm" onClick={() => nav('sessions', { id: inc.top.session_id })}>Session</button>}
                  </div>
                </div>
                <div className="card-b" style={{ paddingTop: 8 }}>
                  <table className="table">
                    <tbody>
                      {inc.alerts.map((a) => (
                        <tr key={a.alert_id} className="clickable" onClick={() => void openAlert(a)}>
                          <td style={{ width: 90 }}><SevBadge s={a.severity} /></td>
                          <td>{a.title}{a.count > 1 && <span className="badge" style={{ marginLeft: 6 }} title="deduplicated occurrences">×{a.count}</span>}</td>
                          <td className="muted" style={{ width: 150 }}>{fmtDateTime(a.last_ts)}</td>
                          <td style={{ width: 230, textAlign: 'right' }} onClick={(e) => e.stopPropagation()}>
                            {a.status !== 'acknowledged' && <button className="btn sm" onClick={() => void setAlert(a.alert_id, 'acknowledged')}>Acknowledge</button>}{' '}
                            {a.status !== 'open' ? <button className="btn sm" onClick={() => void setAlert(a.alert_id, 'open')}>Reopen</button>
                              : <button className="btn sm ghost" onClick={() => void setAlert(a.alert_id, 'suppressed')}>Suppress</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))
          ) : (
            <div className="card" style={{ maxHeight: 'calc(100vh - 290px)', overflow: 'auto' }}>
              {filteredDets.length === 0 ? <Empty title="No detections" /> : (
                <table className="table">
                  <thead><tr><th>Severity</th><th>Rule</th><th>Class</th><th>Agent</th><th>Evidence</th><th>Confidence</th><th>When</th></tr></thead>
                  <tbody>
                    {filteredDets.map((d) => (
                      <tr key={d.detection_id} className="clickable" onClick={() => setOpenDet(d)}>
                        <td><SevBadge s={d.severity} /></td>
                        <td>{d.rule_name}</td>
                        <td className="dim">{d.classification === 'policy_violation' ? 'Violation' : d.classification === 'observation' ? 'Observation' : 'Indicator'}</td>
                        <td><AgentChip type={d.agent_type} /></td>
                        <td className="mono ellipsis dim" style={{ maxWidth: 320 }} title={d.evidence[0]}>{d.evidence[0]}</td>
                        <td className="num">{Math.round(d.confidence * 100)}%</td>
                        <td className="muted">{fmtAgo(d.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          )}
        </div>
        <div className="grid" style={{ gap: 14 }}>
          <Card title="By risk dimension"><BarList items={dimCounts} render={(k) => <span style={{ fontFamily: 'system-ui' }}>{DIM_LABEL[k] ?? k}</span>} /></Card>
          <Card title="Principle">
            <div className="dim" style={{ fontSize: 12.5 }}>
              <p style={{ marginTop: 0 }}><strong>Observations</strong> are facts worth knowing (a package was installed).</p>
              <p><strong>Indicators</strong> look suspicious and need a human to judge intent. Nothing is labelled malicious from pattern alone.</p>
              <p style={{ marginBottom: 0 }}><strong>Violations</strong> broke a policy you configured.</p>
            </div>
          </Card>
        </div>
      </div>
      {openDet && <DetectionDrawer d={openDet} onClose={() => setOpenDet(null)} extra={
        <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
          {openDet.session_id && <button className="btn" onClick={() => nav('sessions', { id: openDet.session_id! })}>Open session timeline</button>}
          <button className="btn" onClick={async () => {
            const cfg = (await invoke<any>('config.get')).config;
            await invoke('config.update', { alerts: { suppressions: [...cfg.alerts.suppressions, { rule_id: openDet.rule_id, agent_type: openDet.agent_type }] } });
            setOpenDet(null);
          }}>Suppress rule for {agentName(openDet.agent_type)}</button>
        </div>
      } />}
    </div>
  );
}

const EMPTY_POLICY = {
  id: 'my-policy', name: 'New policy', description: '', enabled: true, mode: 'alert', severity: 'MEDIUM', dimension: 'policy',
  event_types: ['command_execution'], agent_types: [], conditions: [{ field: 'payload.command', op: 'contains', value: 'terraform apply' }],
  recommended_action: 'Confirm with the owner before applying infrastructure changes.',
};

export function PoliciesPage(_: PageProps) {
  const { data: cfg, refetch } = useQuery<any>('config.get', null);
  const { data: rules } = useQuery<any>('rules', null);
  const [editing, setEditing] = useState<{ index: number | null; text: string; error?: string } | null>(null);
  const [ruleSearch, setRuleSearch] = useState('');
  if (!cfg || !rules) return <div className="muted">Loading…</div>;
  const policies: any[] = cfg.config.policies;
  const disabled: string[] = cfg.config.detection.disabled_rules;

  const save = async (next: any[]) => { await invoke('config.update', { policies: next }); await refetch(); };
  const commit = async () => {
    if (!editing) return;
    try {
      const p = JSON.parse(editing.text);
      const next = [...policies];
      if (editing.index == null) next.push(p); else next[editing.index] = p;
      await save(next);
      setEditing(null);
    } catch (e) {
      setEditing({ ...editing, error: (e as Error).message });
    }
  };
  const toggleRule = async (id: string) => {
    const next = disabled.includes(id) ? disabled.filter((r) => r !== id) : [...disabled, id];
    await invoke('config.update', { detection: { disabled_rules: next } });
    await refetch();
  };
  const q = ruleSearch.toLowerCase();

  return (
    <div className="grid" style={{ gap: 14 }}>
      <Card title="Policies" sub="your rules for what should be flagged" right={<button className="btn primary sm" onClick={() => setEditing({ index: null, text: JSON.stringify(EMPTY_POLICY, null, 2) })}>New policy</button>}>
        <div className="dim" style={{ marginBottom: 10, fontSize: 12.5 }}>
          <strong>Observe</strong> records matches without alerting. <strong>Alert</strong> raises a confirmed policy violation. <strong>Require approval</strong> additionally asks the agent to get human approval before acting; this works where the runtime supports blocking hooks (Claude Code PreToolUse, Codex, Cursor before-hooks). Elsewhere it behaves like Alert.
        </div>
        {policies.length === 0 ? <Empty title="No policies" /> : (
          <table className="table">
            <thead><tr><th>Enabled</th><th>Policy</th><th>Mode</th><th>Severity</th><th>Applies to</th><th /></tr></thead>
            <tbody>
              {policies.map((p, i) => (
                <tr key={p.id}>
                  <td><Switch checked={p.enabled} label={`Enable ${p.name}`} onChange={(v) => void save(policies.map((x, j) => (j === i ? { ...x, enabled: v } : x)))} /></td>
                  <td><div>{p.name}</div><div className="muted" style={{ fontSize: 12 }}>{p.description}</div></td>
                  <td>
                    <select className="input" value={p.mode} aria-label="Mode" onChange={(e) => void save(policies.map((x, j) => (j === i ? { ...x, mode: e.target.value } : x)))}>
                      <option value="observe">Observe</option><option value="alert">Alert</option><option value="require_approval">Require approval</option>
                    </select>
                  </td>
                  <td><SevBadge s={p.severity} /></td>
                  <td className="dim" style={{ fontSize: 12 }}>{p.event_types.join(', ')}</td>
                  <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                    <button className="btn sm" onClick={() => setEditing({ index: i, text: JSON.stringify(p, null, 2) })}>Edit</button>{' '}
                    <button className="btn sm danger" onClick={() => void save(policies.filter((_, j) => j !== i))}>Delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      <Card title="Detection rules" sub={`${rules.rules.length} built-in rules · ${disabled.length} disabled`} right={<SearchInput value={ruleSearch} onChange={setRuleSearch} placeholder="Search rules" />}>
        <table className="table">
          <thead><tr><th>On</th><th>Rule</th><th>Severity</th><th>Dimension</th><th>Class</th><th>Applies to</th></tr></thead>
          <tbody>
            {rules.rules.filter((r: any) => !q || r.name.toLowerCase().includes(q) || r.id.includes(q) || r.description.toLowerCase().includes(q)).map((r: any) => (
              <tr key={r.id}>
                <td><Switch checked={!disabled.includes(r.id)} label={`Enable ${r.name}`} onChange={() => void toggleRule(r.id)} /></td>
                <td><div>{r.name}</div><div className="muted" style={{ fontSize: 12 }}>{r.description}</div><div className="mono muted" style={{ fontSize: 11 }}>{r.id}{r.references?.length ? ` · ${r.references.join(', ')}` : ''}</div></td>
                <td><SevBadge s={r.severity} /></td>
                <td className="dim">{DIM_LABEL[r.dimension]}</td>
                <td className="dim">{r.classification === 'observation' ? 'Observation' : 'Indicator'}</td>
                <td className="dim" style={{ fontSize: 12 }}>{r.event_types.join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {editing && (
        <Drawer title={editing.index == null ? 'New policy' : 'Edit policy'} onClose={() => setEditing(null)} actions={<button className="btn primary sm" onClick={() => void commit()}>Save</button>}>
          <div className="dim" style={{ fontSize: 12.5, marginBottom: 8 }}>
            Condition fields use dotted paths into the event (for example <span className="mono">payload.command</span>, <span className="mono">payload.path</span>, <span className="mono">payload.host</span>, <span className="mono">payload.mcp_server</span>, <span className="mono">agent_type</span>, <span className="mono">workspace</span>). Operators: equals, contains, matches (regex), glob, in, not_in, gt, lt, exists. All conditions must match.
          </div>
          <textarea className="input" style={{ width: '100%', minHeight: 420 }} value={editing.text} onChange={(e) => setEditing({ ...editing, text: e.target.value, error: undefined })} spellCheck={false} aria-label="Policy JSON" />
          {editing.error && <div className="banner warn" style={{ margin: '8px 0 0' }}>{editing.error}</div>}
        </Drawer>
      )}
    </div>
  );
}
