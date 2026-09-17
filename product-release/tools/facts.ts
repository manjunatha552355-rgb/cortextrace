// Extracts verifiable facts from source and the demo database for the fact-validation report.
import { writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { BUILTIN_ADAPTERS } from '../../src/adapters/builtin.ts';
import { RULES } from '../../src/detection/rules.ts';
import { EVENT_TYPES, RISK_DIMENSIONS } from '../../src/core/schema.ts';
import { DEFAULT_POLICIES } from '../../src/detection/policy.ts';

const db = new DatabaseSync('F:/CortextraceDemo/data/cortextrace.db', { readOnly: true });
const one = (q: string) => Object.values(db.prepare(q).get() as Record<string, unknown>)[0];
const facts = {
  adapters: BUILTIN_ADAPTERS.map((a) => ({ id: a.id, name: a.displayName, runtime: a.runtime, caps: a.capabilities, hooks: !!a.normalizeHook, installer: !!a.install, otlp: a.otlpServiceNames ?? [] })),
  rules: RULES.map((r) => ({ id: r.id, name: r.name, severity: r.severity, dimension: r.dimension, classification: r.classification })),
  event_types: EVENT_TYPES,
  risk_dimensions: RISK_DIMENSIONS,
  default_policies: DEFAULT_POLICIES.map((p) => p.id),
  demo_db: {
    events: one('select count(*) from events'), sessions: one('select count(*) from sessions'),
    detections: one('select count(*) from detections where severity>0'), alerts: one('select count(*) from alerts'),
    by_source: db.prepare('select source, count(*) n from events group by source').all(),
  },
};
writeFileSync(new URL('./facts.json', import.meta.url), JSON.stringify(facts, null, 2));
console.log(`adapters=${facts.adapters.length} rules=${facts.rules.length} event_types=${facts.event_types.length} dims=${facts.risk_dimensions.length}`);
console.log(facts.adapters.map((a) => `${a.id}${a.installer ? '*' : ''}`).join(', '));
console.log(JSON.stringify(facts.demo_db));
