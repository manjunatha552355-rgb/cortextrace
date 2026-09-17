import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RULES } from '../src/detection/rules.ts';

test('rule ids are unique', () => {
  const ids = RULES.map((r) => r.id);
  assert.equal(new Set(ids).size, ids.length);
});

for (const rule of RULES) {
  test(`rule ${rule.id} examples`, () => {
    assert.ok(rule.examples.match.length > 0, 'needs positive examples');
    assert.ok(rule.examples.no_match.length > 0, 'needs negative examples');
    const hit = (s: string) => rule.pattern.test(s) && !(rule.exclude?.test(s) ?? false);
    for (const s of rule.examples.match) assert.ok(hit(s), `should match: ${s}`);
    for (const s of rule.examples.no_match) assert.ok(!hit(s), `should not match: ${s}`);
  });
}
