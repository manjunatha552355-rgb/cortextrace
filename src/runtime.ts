import type { Server } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Engine, type EngineOptions } from './core/engine.ts';
import { createApiServer, listen } from './api/server.ts';

// Matches Electron's userData location for productName "Cortextrace", so the desktop app and headless engine share data.
export function defaultDataDir() {
  if (process.env.CORTEXTRACE_HOME) return process.env.CORTEXTRACE_HOME;
  if (process.platform === 'win32') return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Cortextrace');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cortextrace');
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'Cortextrace');
}

export interface Runtime {
  engine: Engine;
  api: Server | null;
  otlp: Server | null;
  errors: string[];
  stop(): Promise<void>;
}

export async function startRuntime(opts: EngineOptions): Promise<Runtime> {
  const engine = new Engine(opts);
  const errors: string[] = [];
  engine.start();

  const cfg = engine.cfg();
  let api: Server | null = createApiServer(engine, { port: cfg.api.port });
  try {
    await listen(api, cfg.api.port);
  } catch (e) {
    // Port conflicts degrade functionality (no hooks/API) but must not stop local monitoring.
    errors.push(`API port ${cfg.api.port} unavailable: ${(e as Error).message}`);
    engine.log.error('api', errors.at(-1)!);
    api = null;
  }

  let otlp: Server | null = null;
  if (cfg.monitoring.otlp.enabled) {
    otlp = createApiServer(engine, { port: cfg.monitoring.otlp.port, otlpOpen: true });
    try {
      await listen(otlp, cfg.monitoring.otlp.port);
    } catch (e) {
      errors.push(`OTLP port ${cfg.monitoring.otlp.port} unavailable (another collector running?): ${(e as Error).message}`);
      engine.log.warn('otlp', errors.at(-1)!);
      otlp = null;
    }
  }

  return {
    engine, api, otlp, errors,
    async stop() {
      await Promise.all([api, otlp].map((s) => s && new Promise<void>((r) => { s.closeAllConnections(); s.close(() => r()); })));
      await engine.stop();
    },
  };
}
