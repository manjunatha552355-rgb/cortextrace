import { contextBridge, ipcRenderer } from 'electron';

const CHANNELS = new Set([
  'overview', 'events', 'events.count', 'event', 'agents', 'agent.trust', 'sessions', 'session', 'detections', 'alerts', 'alert.status',
  'graph', 'processes', 'system', 'analytics', 'inventory', 'rules', 'config.get', 'config.update', 'integrations', 'integration.set',
  'maintenance.integrity', 'maintenance.retention', 'maintenance.rediscover', 'export.events', 'export.diagnostics', 'open.dataDir', 'open.path', 'app.quit',
]);

// The renderer gets a narrow, allow-listed bridge; no Node or Electron objects cross into the page.
contextBridge.exposeInMainWorld('cortex', {
  invoke: (channel: string, args?: unknown) => {
    if (!CHANNELS.has(channel)) return Promise.reject(new Error(`channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, args);
  },
  onStream: (fn: (batch: unknown) => void) => {
    const h = (_e: unknown, b: unknown) => fn(b);
    ipcRenderer.on('stream', h);
    return () => ipcRenderer.removeListener('stream', h);
  },
  onNavigate: (fn: (target: unknown) => void) => {
    const h = (_e: unknown, t: unknown) => fn(t);
    ipcRenderer.on('navigate', h);
    return () => ipcRenderer.removeListener('navigate', h);
  },
});
