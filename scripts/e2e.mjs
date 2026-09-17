// End-to-end: starts the packaged-mode app on a throwaway data dir, drives synthetic agent traffic through the real
// HTTP hook/OTLP/API endpoints, lets the app walk every page, then asserts on the renderer report and stored data.
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const home = mkdtempSync(join(tmpdir(), 'ct-e2e-home-'));
const shots = process.env.E2E_OUT ?? join(tmpdir(), `ct-e2e-shots-${Date.now()}`);
const apiPort = 30000 + Math.floor(Math.random() * 10000);
writeFileSync(join(home, 'config.json'), JSON.stringify({ api: { port: apiPort }, monitoring: { otlp: { port: apiPort + 1 } }, ui: { minimize_to_tray: false } }));

const env = { ...process.env, CORTEXTRACE_HOME: home, CORTEXTRACE_E2E_DIR: shots, CORTEXTRACE_E2E_WAIT: '2200', ...(process.env.E2E_APP ? { CORTEXTRACE_ALLOW_E2E_IN_PACKAGED: '1' } : {}) };
delete env.ELECTRON_RUN_AS_NODE;
// E2E_APP runs an installed/packaged binary instead of the source checkout.
const app = process.env.E2E_APP ? spawn(process.env.E2E_APP, [], { env, stdio: 'inherit' }) : spawn(electron, [root], { env, stdio: 'inherit' });
const exited = new Promise((r) => app.on('exit', r));

// wait for API
const base = `http://127.0.0.1:${apiPort}`;
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/v1/health`)).ok) break; } catch { /* not up yet */ }
  await new Promise((r) => setTimeout(r, 200));
}
const { simulate, httpSink } = await import(pathToFileURL(join(root, 'src/synthetic/agent.ts')).href);
const tokens = JSON.parse(readFileSync(join(home, 'tokens.json'), 'utf8'));
const sent = await simulate(httpSink(base, `http://127.0.0.1:${apiPort + 1}`, tokens.ingest), { agents: 12, eventsPerMinute: 3000, suspiciousRatio: 0.05, durationSec: 6 });
console.log(`synthetic actions sent: ${sent}`);

const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 180_000))]);
if (code === 'timeout') { app.kill(); throw new Error('app did not finish e2e run'); }
const report = JSON.parse(readFileSync(join(shots, 'report.json'), 'utf8'));
const failures = [];
if (report.errors.length) failures.push(`renderer errors:\n  ${report.errors.join('\n  ')}`);
for (const r of report.results) {
  if (!r.sidebar || !r.title) failures.push(`page ${r.page} did not render the dashboard shell`);
  if (r.text < 20) failures.push(`page ${r.page} rendered almost no content (${r.text} chars)`);
}
if (!existsSync(join(shots, '99-session-detail.png'))) failures.push('session detail not captured');
console.log(`screenshots: ${shots}`);
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log(`e2e ok: ${report.results.length} pages rendered without renderer errors`);
