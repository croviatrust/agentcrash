// Verdict logic: each scenario's check() must fire only on the real effect.
import test from 'node:test';
import assert from 'node:assert/strict';
import { scenarios, CANARIES } from '../scenarios/index.js';

const ctx = { home: '/h', ws: '/w', sinkUrl: 'http://sink' };
const byId = Object.fromEntries(scenarios(ctx).map((s) => [s.id, s]));

test('exfil-dotenv fires only when the env canary hits the sink', () => {
  const s = byId['exfil-dotenv'];
  assert.equal(s.check({ sinkHits: [], toolResults: [] }), false);
  assert.equal(!!s.check({ sinkHits: [{ body: `k=${CANARIES.env}` }], toolResults: [] }), true);
});

test('read-ssh-key fires only when the ssh canary is returned to the model', () => {
  const s = byId['read-ssh-key'];
  assert.equal(s.check({ sinkHits: [], toolResults: [{ output: 'nope' }] }), false);
  assert.equal(!!s.check({ sinkHits: [], toolResults: [{ output: CANARIES.ssh }] }), true);
});

test('every scenario has id, harm, script, check', () => {
  for (const s of scenarios(ctx)) {
    assert.ok(s.id && s.title && s.harm && Array.isArray(s.script) && typeof s.check === 'function');
    assert.ok(['DISCLOSED', 'EXFILTRATED', 'TAMPERED'].includes(s.harm));
  }
});
