import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { invoke, useQuery, RANGES, type RangeId } from './lib.ts';
import { Icon, Logo, Segmented } from './ui.tsx';
import { OverviewPage, LivePage } from './pages/overview.tsx';
import { AgentsPage, SessionsPage, SessionDetailPage } from './pages/agents.tsx';
import { ThreatsPage, PoliciesPage } from './pages/threats.tsx';
import { TimelinePage, ExplorerPage, ProcessesPage, EXPLORERS } from './pages/explore.tsx';
import { GraphPage } from './pages/graph.tsx';
import { AnalyticsPage, HealthPage } from './pages/analytics.tsx';
import { SettingsPage, Onboarding } from './pages/settings.tsx';

export interface Route { page: string; params: Record<string, string> }
export interface PageProps {
  route: Route;
  nav: (page: string, params?: Record<string, string>) => void;
  range: RangeId;
  from: number;
  to: number;
}

const NAV: { group: string; items: { id: string; label: string; icon: string }[] }[] = [
  { group: 'Monitor', items: [
    { id: 'overview', label: 'Overview', icon: 'overview' }, { id: 'live', label: 'Live Activity', icon: 'live' },
    { id: 'threats', label: 'Threats', icon: 'threats' }, { id: 'timeline', label: 'Timeline', icon: 'timeline' },
  ] },
  { group: 'Inventory', items: [
    { id: 'agents', label: 'Agents', icon: 'agents' }, { id: 'sessions', label: 'Sessions', icon: 'sessions' },
    { id: 'graph', label: 'Relationships', icon: 'graph' }, { id: 'processes', label: 'Processes', icon: 'processes' },
  ] },
  { group: 'Activity', items: [
    { id: 'commands', label: 'Commands', icon: 'commands' }, { id: 'files', label: 'Files', icon: 'files' },
    { id: 'tools', label: 'Tools', icon: 'tools' }, { id: 'network', label: 'Network', icon: 'network' }, { id: 'mcp', label: 'MCP', icon: 'mcp' },
  ] },
  { group: 'Manage', items: [
    { id: 'policies', label: 'Policies', icon: 'policies' }, { id: 'analytics', label: 'Analytics', icon: 'analytics' },
    { id: 'health', label: 'System Health', icon: 'health' }, { id: 'settings', label: 'Settings', icon: 'settings' },
  ] },
];
const TITLES = Object.fromEntries(NAV.flatMap((g) => g.items.map((i) => [i.id, i.label])));

function parseHash(): Route {
  const [page = 'overview', query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { page: page || 'overview', params: Object.fromEntries(new URLSearchParams(query)) };
}

export function App() {
  const [route, setRoute] = useState<Route>(parseHash);
  const [range, setRange] = useState<RangeId>(() => (localStorage.getItem('range') as RangeId) || '24h');
  const [now, setNow] = useState(Date.now());
  const { data: cfg, refetch: refetchCfg } = useQuery<any>('config.get', null, { interval: 10_000 });
  const { data: sys } = useQuery<any>('system', null, { interval: 15_000 });
  const { data: openAlerts } = useQuery<any[]>('alerts', { status: 'open', from: Date.now() - 86400_000 }, { interval: 10_000 });

  useEffect(() => {
    const h = () => setRoute(parseHash());
    window.addEventListener('hashchange', h);
    const off = window.cortex.onNavigate((t) => { location.hash = `#/${t.page}`; });
    const tick = setInterval(() => setNow(Date.now()), 5000);
    return () => { window.removeEventListener('hashchange', h); off(); clearInterval(tick); };
  }, []);

  useEffect(() => {
    const theme = cfg?.config?.ui?.theme;
    if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
    else delete document.documentElement.dataset.theme;
  }, [cfg?.config?.ui?.theme]);

  const nav = useCallback((page: string, params: Record<string, string> = {}) => {
    const q = new URLSearchParams(params).toString();
    location.hash = `#/${page}${q ? `?${q}` : ''}`;
  }, []);

  const changeRange = (r: RangeId) => { setRange(r); localStorage.setItem('range', r); };
  const to = now + 1000;
  const from = to - RANGES.find((r) => r.id === range)!.ms;

  if (cfg && !cfg.config.ui.onboarded) {
    return <Onboarding cfg={cfg} done={async () => { await invoke('config.update', { ui: { onboarded: true } }); await refetchCfg(); }} />;
  }

  const paused = cfg?.config?.monitoring?.paused;
  const degraded = sys && (sys.collectors.some((c: any) => c.state === 'degraded') || !sys.database.ok || cfg?.startup_errors?.length);
  const props: PageProps = { route, nav, range, from, to };
  let page: ReactNode;
  const explorer = EXPLORERS[route.page];
  switch (route.page) {
    case 'overview': page = <OverviewPage {...props} />; break;
    case 'live': page = <LivePage {...props} />; break;
    case 'agents': page = <AgentsPage {...props} />; break;
    case 'sessions': page = route.params.id ? <SessionDetailPage {...props} /> : <SessionsPage {...props} />; break;
    case 'threats': page = <ThreatsPage {...props} />; break;
    case 'timeline': page = <TimelinePage {...props} />; break;
    case 'graph': page = <GraphPage {...props} />; break;
    case 'processes': page = <ProcessesPage {...props} />; break;
    case 'policies': page = <PoliciesPage {...props} />; break;
    case 'analytics': page = <AnalyticsPage {...props} />; break;
    case 'health': page = <HealthPage {...props} />; break;
    case 'settings': page = <SettingsPage {...props} />; break;
    default: page = explorer ? <ExplorerPage {...props} kind={route.page} /> : <OverviewPage {...props} />;
  }
  const showRange = !['settings', 'policies', 'health', 'processes', 'agents'].includes(route.page) && !(route.page === 'sessions' && route.params.id);

  return (
    <div className="app">
      <nav className="sidebar" aria-label="Main">
        <div className="brand"><Logo /> Cortextrace</div>
        <div className="nav">
          {NAV.map((g) => (
            <div key={g.group}>
              <div className="nav-group">{g.group}</div>
              {g.items.map((it) => (
                <button key={it.id} aria-current={route.page === it.id ? 'page' : undefined} onClick={() => nav(it.id)}>
                  <Icon name={it.icon} />{it.label}
                  {it.id === 'threats' && !!openAlerts?.length && <span className="count" aria-label={`${openAlerts.length} open alerts`}>{openAlerts.length}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
        <div className="sidebar-foot">
          <div className="status-line" role="status">
            <span className={`dot ${paused ? 'paused' : degraded ? 'degraded' : ''}`} />
            {paused ? 'Monitoring paused' : degraded ? 'Running degraded' : 'Monitoring active'}
          </div>
          <button className="btn sm" onClick={async () => { await invoke('config.update', { monitoring: { paused: !paused } }); await refetchCfg(); }}>
            {paused ? 'Resume monitoring' : 'Pause monitoring'}
          </button>
        </div>
      </nav>
      <div className="main">
        <header className="topbar">
          <h1>{route.page === 'sessions' && route.params.id ? <><span className="crumb" role="link" onClick={() => nav('sessions')}>Sessions /</span> Session</> : TITLES[route.page] ?? 'Overview'}</h1>
          <div className="spacer" />
          {showRange && <Segmented label="Time range" value={range} options={RANGES.map((r) => ({ id: r.id, label: r.label }))} onChange={changeRange} />}
        </header>
        {paused && <div className="banner warn">Monitoring is paused. Collectors, hooks and OTLP ingestion are discarding events until you resume.</div>}
        {!paused && cfg?.startup_errors?.map((e: string) => <div key={e} className="banner warn">{e}</div>)}
        {sys && !sys.database.ok && <div className="banner warn">Database integrity problem detected ({sys.database.detail}). A fresh database is in use; the damaged file was preserved at {sys.database.recovered_from ?? 'its original location'}.</div>}
        <main className="content" key={route.page + (route.params.id ?? '')}>{page}</main>
      </div>
    </div>
  );
}
