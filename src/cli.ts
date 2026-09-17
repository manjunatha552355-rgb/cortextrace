import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { startRuntime, defaultDataDir } from './runtime.ts';

const { values } = parseArgs({
  options: {
    'data-dir': { type: 'string' },
    'no-collectors': { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
  },
});

if (values.help) {
  console.log(`cortextrace engine (headless)

  --data-dir <dir>    data directory (default ${defaultDataDir()})
  --no-collectors     disable process/network/filesystem collectors (ingest-only)`);
  process.exit(0);
}

const dataDir = values['data-dir'] ?? defaultDataDir();
const rt = await startRuntime({ dataDir, collectors: !values['no-collectors'] });
const c = rt.engine.cfg();
console.log(`Cortextrace engine running
  data:  ${dataDir}
  api:   ${rt.api ? `http://127.0.0.1:${c.api.port}` : 'unavailable'}
  otlp:  ${rt.otlp ? `http://127.0.0.1:${c.monitoring.otlp.port}` : 'unavailable'}
  tokens: ${join(dataDir, 'tokens.json')}`);
for (const e of rt.errors) console.warn(`warning: ${e}`);

let stopping = false;
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    if (stopping) return;
    stopping = true;
    await rt.stop();
    process.exit(0);
  });
}
