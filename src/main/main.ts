import { app, BrowserWindow, Tray, Menu, Notification, ipcMain, dialog, shell, nativeImage, nativeTheme, session, type IpcMainInvokeEvent } from 'electron';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { startRuntime, type Runtime } from '../runtime.ts';
import type { StreamBatch } from '../core/engine.ts';
import { RULES } from '../detection/rules.ts';
import { DEFAULT_POLICIES } from '../detection/policy.ts';
import { SEVERITIES } from '../core/schema.ts';

const DEV_URL = process.env.CORTEXTRACE_DEV_URL;
let rt: Runtime | null = null;
let win: BrowserWindow | null = null;
let tray: Tray | null = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => showWindow());
  app.whenReady().then(boot).catch((e) => {
    dialog.showErrorBox('Cortextrace failed to start', String(e?.stack ?? e));
    app.exit(1);
  });
}

async function boot() {
  const dataDir = process.env.CORTEXTRACE_HOME ?? app.getPath('userData');
  rt = await startRuntime({
    dataDir,
    notify: (a, d) => {
      if (!Notification.isSupported()) return;
      const n = new Notification({ title: `${a.severity}: ${a.title}`, body: `${d.agent_type} — ${d.reason}`.slice(0, 240), urgency: a.severity === 'CRITICAL' ? 'critical' : 'normal' });
      n.on('click', () => { showWindow(); win?.webContents.send('navigate', { page: 'threats', alert_id: a.alert_id }); });
      n.show();
    },
  });

  // Deny every permission request (camera, geolocation, notifications from web content, etc.).
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [DEV_URL
          ? "default-src 'self' 'unsafe-inline' http://localhost:* ws://localhost:*; img-src 'self' data:"
          : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"],
      },
    });
  });

  registerIpc();
  createTray();
  applyLoginItem();
  rt.engine.config.onChange(() => { applyLoginItem(); updateTray(); });

  // Coalesce stream batches so a burst of telemetry cannot flood the renderer.
  let pending: StreamBatch = { events: [], detections: [], alerts: [] };
  let timer: NodeJS.Timeout | null = null;
  rt.engine.on('batch', (b: StreamBatch) => {
    pending.events.push(...b.events.slice(-500));
    if (pending.events.length > 1000) pending.events = pending.events.slice(-1000);
    pending.detections.push(...b.detections);
    pending.alerts.push(...b.alerts);
    timer ??= setTimeout(() => {
      timer = null;
      if (win && !win.isDestroyed() && win.isVisible()) win.webContents.send('stream', pending);
      pending = { events: [], detections: [], alerts: [] };
      updateTray();
    }, 500);
  });

  const startHidden = process.argv.includes('--hidden');
  if (!startHidden) createWindow();
  for (const err of rt.errors) rt.engine.log.warn('startup', err);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 640,
    title: 'Cortextrace',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#111110' : '#f7f7f5',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => { if (!isTrustedUrl(url)) e.preventDefault(); });
  win.on('close', (e) => {
    if (!quitting && rt?.engine.cfg().ui.minimize_to_tray) {
      e.preventDefault();
      win?.hide();
    }
  });
  win.on('closed', () => { win = null; });
  // Packaged builds require a second explicit opt-in so a stray env var cannot trigger screenshot capture.
  if (process.env.CORTEXTRACE_E2E_DIR && (!app.isPackaged || process.env.CORTEXTRACE_ALLOW_E2E_IN_PACKAGED === '1')) void runE2E(win, process.env.CORTEXTRACE_E2E_DIR);
  if (DEV_URL) void win.loadURL(DEV_URL);
  else void win.loadFile(join(__dirname, 'renderer', 'index.html'));
}

// Test-only: visits every page, screenshots it and records renderer errors, then exits. Enabled solely by env var.
async function runE2E(w: BrowserWindow, outDir: string) {
  const { mkdirSync } = await import('node:fs');
  mkdirSync(outDir, { recursive: true });
  const errors: string[] = [];
  w.webContents.on('console-message', (e) => { if (e.level === 'error') errors.push(e.message); });
  w.webContents.on('render-process-gone', (_e, d) => errors.push(`renderer gone: ${d.reason}`));
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const shot = async (name: string) => writeFileSync(join(outDir, `${name}.png`), (await w.webContents.capturePage()).toPNG());
  const pages = (process.env.CORTEXTRACE_E2E_PAGES ?? 'overview,live,threats,timeline,agents,sessions,graph,processes,commands,files,tools,network,mcp,policies,analytics,health,settings').split(',');
  await wait(2500);
  await shot('00-onboarding');
  rt!.engine.config.update({ ui: { onboarded: true } });
  w.webContents.reload();
  await new Promise<void>((r) => w.webContents.once('did-finish-load', () => r()));
  await wait(1500);
  const results: { page: string; text: number; title: string; sidebar: boolean }[] = [];
  for (const [i, p] of pages.entries()) {
    await w.webContents.executeJavaScript(`location.hash = '#/${p}'`);
    await wait(Number(process.env.CORTEXTRACE_E2E_WAIT ?? 2500));
    const probe = await w.webContents.executeJavaScript('({ text: document.querySelector("main.content")?.innerText.length ?? 0, title: document.querySelector(".topbar h1")?.innerText ?? "", sidebar: !!document.querySelector("nav.sidebar") })');
    results.push({ page: p, ...probe });
    await shot(`${String(i + 1).padStart(2, '0')}-${p}`);
  }
  const firstSession = rt!.engine.store.listSessions({ limit: 1 })[0];
  if (firstSession) {
    await w.webContents.executeJavaScript(`location.hash = '#/sessions?id=${encodeURIComponent(firstSession.session_id)}'`);
    await wait(3000);
    await shot('99-session-detail');
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify({ errors, results }, null, 2));
  quitting = true;
  app.quit();
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
}

function createTray() {
  const icon = nativeImage.createFromPath(join(__dirname, process.platform === 'darwin' ? 'trayTemplate.png' : 'tray.png'));
  if (process.platform === 'darwin') icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.on('click', () => showWindow());
  updateTray();
}

function updateTray() {
  if (!tray || !rt) return;
  const paused = rt.engine.cfg().monitoring.paused;
  const open = rt.engine.store.countAlerts('open', Date.now() - 24 * 3600_000);
  tray.setToolTip(`Cortextrace — ${paused ? 'monitoring paused' : 'monitoring active'}${open ? ` · ${open} open alerts` : ''}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: paused ? 'Monitoring paused' : 'Monitoring active', enabled: false },
    { label: `${open} open alerts (24h)`, enabled: false },
    { type: 'separator' },
    { label: 'Open Cortextrace', click: () => showWindow() },
    { label: paused ? 'Resume monitoring' : 'Pause monitoring', click: () => rt!.engine.config.update({ monitoring: { paused: !paused } }) },
    { type: 'separator' },
    { label: 'Quit Cortextrace', click: () => { quitting = true; app.quit(); } },
  ]));
}

function applyLoginItem() {
  if (!rt || process.platform === 'linux') return; // Linux autostart is handled by the .desktop file documented in docs/INSTALL.md
  const want = rt.engine.cfg().ui.start_on_login;
  if (app.getLoginItemSettings().openAtLogin !== want) app.setLoginItemSettings({ openAtLogin: want, args: ['--hidden'] });
}

function isTrustedUrl(url: string) {
  return DEV_URL ? url.startsWith(DEV_URL) : url.startsWith('file://');
}

// ---------- IPC ----------
type Handler = (args: any) => unknown | Promise<unknown>;

function registerIpc() {
  const e = () => rt!.engine;
  const handlers: Record<string, Handler> = {
    overview: ({ from, to }) => e().overview(num(from), num(to)),
    events: (q) => e().store.queryEvents(sanitizeQuery(q)),
    'events.count': (q) => e().store.countEvents(sanitizeQuery(q)),
    event: ({ id }) => e().store.getEvent(str(id)),
    agents: () => e().store.listAgents(),
    'agent.trust': ({ agent_id, trust }) => {
      if (!['trusted', 'untrusted', 'unknown'].includes(trust)) throw new Error('invalid trust');
      e().store.setAgentTrust(str(agent_id), trust);
      return true;
    },
    sessions: (q) => e().store.listSessions({ agent_id: q?.agent_id ? str(q.agent_id) : undefined, active_since: q?.active_since ? num(q.active_since) : undefined, limit: q?.limit ? num(q.limit) : 1000 }),
    session: ({ id }) => ({ session: e().store.getSession(str(id)), detections: e().store.queryDetections({ session_id: str(id), limit: 2000 }) }),
    detections: (q) => e().store.queryDetections({ from: q?.from ? num(q.from) : undefined, agent_id: q?.agent_id, session_id: q?.session_id, min_severity: SEVERITIES.includes(q?.min_severity) ? q.min_severity : undefined, limit: q?.limit ? num(q.limit) : 2000 }),
    alerts: (q) => e().store.listAlerts({ status: q?.status, from: q?.from ? num(q.from) : undefined, limit: 2000 }),
    'alert.status': ({ alert_id, status }) => {
      if (!['open', 'acknowledged', 'suppressed'].includes(status)) throw new Error('invalid status');
      e().store.setAlertStatus(str(alert_id), status);
      updateTray();
      return true;
    },
    graph: (q) => e().graph({ from: num(q?.from ?? 0), session_id: q?.session_id, agent_id: q?.agent_id }),
    processes: () => e().processTree(),
    system: () => e().systemHealth(),
    analytics: ({ from, to }) => analytics(num(from), num(to)),
    inventory: ({ kind }) => e().store.listInventory(str(kind)),
    rules: () => ({ rules: RULES.map(({ pattern, exclude, ...r }) => ({ ...r, pattern: pattern.source })), default_policies: DEFAULT_POLICIES }),
    'config.get': () => ({ config: e().cfg(), error: e().config.lastError, data_dir: app.getPath('userData'), api_port: rt!.api ? e().cfg().api.port : null, otlp_port: rt!.otlp ? e().cfg().monitoring.otlp.port : null, startup_errors: rt!.errors, version: app.getVersion(), platform: process.platform }),
    'config.update': (patch) => e().config.update(patch),
    integrations: () => e().integrations(),
    'integration.set': ({ adapter_id, integration_id, install }) => e().installIntegration(str(adapter_id), str(integration_id), !!install),
    'maintenance.integrity': () => e().integrity(),
    'maintenance.retention': () => { e().retention(); return e().store.stats(); },
    'maintenance.rediscover': () => { e().discoverInstalled(); return true; },
    'export.events': async ({ query, format }) => {
      const fmt = format === 'csv' ? 'csv' : 'jsonl';
      const r = await dialog.showSaveDialog(win!, { defaultPath: `cortextrace-events-${new Date().toISOString().slice(0, 10)}.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] });
      if (r.canceled || !r.filePath) return null;
      return { file: r.filePath, count: await e().exportEvents(sanitizeQuery(query ?? {}), fmt, r.filePath) };
    },
    'export.diagnostics': async () => {
      const r = await dialog.showSaveDialog(win!, { defaultPath: `cortextrace-diagnostics-${Date.now()}.json` });
      if (r.canceled || !r.filePath) return null;
      writeFileSync(r.filePath, JSON.stringify(e().diagnostics(), null, 2), { mode: 0o600 });
      return { file: r.filePath };
    },
    'open.dataDir': () => shell.openPath(app.getPath('userData')),
    'open.path': ({ path }) => shell.showItemInFolder(str(path)),
    'app.quit': () => { quitting = true; app.quit(); },
  };

  for (const [channel, fn] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (ev: IpcMainInvokeEvent, args) => {
      if (!ev.senderFrame || !isTrustedUrl(ev.senderFrame.url)) throw new Error('untrusted sender');
      return fn(args ?? {});
    });
  }
}

function analytics(from: number, to: number) {
  const s = rt!.engine.store;
  const db = s.db;
  const day = 86400_000;
  const bucket = to - from > 3 * day ? day : 3600_000;
  return {
    bucket_ms: bucket,
    by_agent: s.timeseries(from, to, bucket, 'agent_type'),
    by_type: s.timeseries(from, to, bucket, 'event_type', ['command_execution', 'file_modified', 'file_created', 'file_deleted', 'file_read', 'tool_call', 'mcp_call', 'network_connection_metadata']),
    risk_trend: db.prepare(`SELECT CAST(ts/? AS INTEGER)*? bucket, dimension series, COUNT(*) n FROM detections WHERE ts BETWEEN ? AND ? AND severity>0 GROUP BY bucket, series ORDER BY bucket`).all(bucket, bucket, from, to),
    hour_of_week: s.hourOfWeek(from),
    session_durations: db.prepare(`SELECT agent_type, (COALESCE(ended_at,last_activity)-started_at) d FROM sessions WHERE started_at BETWEEN ? AND ?`).all(from, to),
    top_rules: db.prepare(`SELECT rule_id, rule_name, dimension, MAX(severity) severity, COUNT(*) n FROM detections WHERE ts BETWEEN ? AND ? GROUP BY rule_id ORDER BY n DESC LIMIT 15`).all(from, to),
    workspaces: db.prepare(`SELECT workspace key, COUNT(*) n, COUNT(DISTINCT session_id) sessions, MAX(risk_score) risk FROM events WHERE ts BETWEEN ? AND ? AND workspace IS NOT NULL GROUP BY workspace ORDER BY n DESC LIMIT 15`).all(from, to),
    agent_compare: db.prepare(`SELECT agent_type, COUNT(*) events, COUNT(DISTINCT session_id) sessions, SUM(event_type='command_execution') commands,
                               SUM(event_type IN ('file_modified','file_created','file_deleted')) file_changes, SUM(event_type='mcp_call') mcp, SUM(event_type IN ('security_detection','policy_violation')) detections, MAX(risk_score) max_risk
                               FROM events WHERE ts BETWEEN ? AND ? GROUP BY agent_type ORDER BY events DESC`).all(from, to),
    command_binaries: db.prepare(`SELECT summary key, COUNT(*) n FROM events WHERE ts BETWEEN ? AND ? AND event_type='command_execution' GROUP BY summary ORDER BY n DESC LIMIT 400`).all(from, to),
    baselines: db.prepare('SELECT * FROM baselines').all(),
  };
}

const num = (v: unknown) => {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error('expected number');
  return n;
};
const str = (v: unknown) => {
  if (typeof v !== 'string' || v.length > 4096) throw new Error('expected string');
  return v;
};

function sanitizeQuery(q: any) {
  return {
    from: q.from != null ? num(q.from) : undefined, to: q.to != null ? num(q.to) : undefined,
    agent_id: q.agent_id ? str(q.agent_id) : undefined, agent_type: q.agent_type ? str(q.agent_type) : undefined,
    session_id: q.session_id ? str(q.session_id) : undefined, correlation_id: q.correlation_id ? str(q.correlation_id) : undefined,
    types: Array.isArray(q.types) ? q.types.map(str) : undefined, sources: Array.isArray(q.sources) ? q.sources.map(str) : undefined,
    min_severity: SEVERITIES.includes(q.min_severity) ? q.min_severity : undefined,
    search: q.search ? str(q.search).slice(0, 200) : undefined, limit: q.limit != null ? num(q.limit) : undefined,
    offset: q.offset != null ? num(q.offset) : undefined, order: q.order === 'asc' ? 'asc' as const : 'desc' as const,
  };
}

app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => { /* keep running in the tray; quit from the tray menu */ });
app.on('activate', () => showWindow());
let stopped = false;
app.on('will-quit', (ev) => {
  if (stopped || !rt) return;
  ev.preventDefault();
  stopped = true;
  void rt.stop().finally(() => app.exit(0));
});
