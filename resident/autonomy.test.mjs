import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { runAutonomy, retainMethods, validateMethod } from './autonomy.mjs';
import { initialState, json } from './core.mjs';
import { runProbe } from './probe.mjs';
import { verify } from './verify.mjs';
import { refreshAgenda, advanceAgenda, chooseCommitment } from './agenda.mjs';
const repo = 'croviatrust/agentcrash', strategy = json(new URL('./strategy.json', import.meta.url));
const method = { mode: 'contract-first', observation: 'The first attempt stopped without running a regression.',
  instructions: 'Read the implementation, execute a small regression, then propose a minimal source replacement using the probe id.',
  falsifier: 'The next attempt still does not produce an executable candidate that passes independent before/after checks.' };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-fixture-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
  fs.writeFileSync(path.join(root, 'src/value.js'), 'export const valid = x => !!x;\n');
  fs.writeFileSync(path.join(root, 'test/old.test.mjs'), "import assert from 'node:assert/strict'; import {valid} from '../src/value.js'; assert.equal(valid(1),true);\n");
  execFileSync('git', ['init', '-q', root]); execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.com', 'commit', '-qm', 'baseline'], { cwd: root });
  return root;
}
function localRun(dir, command) {
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const args = command.split(' ').slice(1).flatMap(a => a === 'resident-regressions/*.test.mjs' ? fs.readdirSync(path.join(dir, 'resident-regressions')).filter(n => n.endsWith('.test.mjs')).map(n => `resident-regressions/${n}`) : [a]);
  const result = spawnSync(process.execPath, args, { cwd: dir, env, encoding: 'utf8', timeout: 10000 });
  return { code: result.status, error: result.error?.message, log: `${result.stdout || ''}${result.stderr || ''}` };
}
async function recovered(t) {
  const root = fixture(t), events = [], roles = []; let stage = 0, researchAfterFailure = false;
  const content = "import assert from 'node:assert/strict'; import {valid} from '../src/value.js'; assert.equal(valid(0),true);\n";
  const actions = [{ action: 'read', path: 'src/value.js' }, { action: 'probe', content }, { action: 'propose', title: 'Accept zero', hypothesis: 'Zero is valid', benefit: 'Accept zero input', falsifier: 'Zero already succeeds', edits: [
    { path: 'src/value.js', before: '!!x', after: 'x !== null' }, { path: 'resident-regressions/zero.test.mjs', probeId: 'probe-1' }] }];
  const e = await runAutonomy({ root, repo, state: initialState(), context: {}, strategy, enableEncounters: false, onEvent: event => events.push(event),
    study: async () => { researchAfterFailure ||= stage === 1; return { sources: [{ kind: 'fixture', url: 'https://nodejs.org/api/assert.html', excerpt: 'Fixture reference, not a live fetch.' }], errors: [] }; },
    probe: request => runProbe(request, { run: localRun }), evaluate: e => verify(root, e, { run: localRun }),
    ask: async (messages, { role }) => {
      roles.push(role);
      let value;
      if (role === 'recovery-researcher') { stage = 1; value = { method, research: { documents: ['https://nodejs.org/api/assert.html'] } }; }
      else if (role === 'scout') { if (stage) assert.ok(JSON.stringify(messages).includes(method.instructions)); value = { mission: 'Test the zero input contract' }; }
      else if (role === 'critic') value = { decision: stage ? 'accept' : 'revise', reason: stage ? 'Execute the coherent regression and source change' : 'The first attempt produced no experiment' };
      else value = stage ? actions.shift() : { action: 'stop', reason: 'Need an executable regression', next: 'Construct a test' };
      return { text: JSON.stringify(value), model: 'explicit-test-double' };
    } });
  return { root, e, events, roles, researchAfterFailure };
}
test('a failed attempt autonomously triggers method research and a changed retry with real before/after execution', async t => {
  const { root, e, events, researchAfterFailure } = await recovered(t);
  assert.equal(e.autonomy.attempts.length, 2); assert.equal(e.autonomy.attempts[0].verdict.status, 'stopped');
  assert.equal(e.autonomy.attempts[1].verdict.status, 'verified'); assert.ok(researchAfterFailure);
  assert.ok(events.some(x => x.event === 'autonomy-learned-hypothesis'));
  assert.equal(e.autonomy.lessons[0].method.status, 'unverified-hypothesis');
  assert.equal(fs.readFileSync(path.join(root, 'src/value.js'), 'utf8'), 'export const valid = x => !!x;\n');
});
test('a method is promoted only by the separate independent verifier, not a learner claim or local success flag', async t => {
  const { root, e } = await recovered(t);
  const unverified = retainMethods([], e, { status: 'verified', episode: e.id, checks: [] });
  assert.equal(unverified[0].status, 'unverified-hypothesis'); assert.equal(unverified[0].validations.length, 0);
  const verdict = await verify(root, e, { run: localRun });
  const retained = retainMethods([], e, verdict);
  assert.equal(retained[0].status, 'verified-on-source-case'); assert.equal(retained[0].validations[0].episode, e.id);
  assert.equal(retained[0].sources[0].excerpt, undefined);
});
test('shared call and retry budgets hold even if every engineering attempt fails', async t => {
  const root = fixture(t); let calls = 0, attempts = 0;
  const e = await runAutonomy({ root, repo, state: initialState(), context: {}, strategy,
    fleet: async ({ ask, modelBudget }) => { attempts++; for (let i = 0; i < modelBudget; i++) await ask([], { role: 'specialist-fixture' }); return { id: `attempt-${attempts}`, repo, status: 'stopped', trace: [], reason: 'Unresolved' }; },
    evaluate: async e => ({ episode: e.id, status: 'stopped' }), study: async () => ({ sources: [], errors: [] }),
    ask: async (_, { role }) => { calls++; return { text: JSON.stringify(role === 'recovery-researcher' ? { method } : {}) }; } });
  assert.equal(calls, 14); assert.equal(attempts, 2); assert.equal(e.autonomy.modelCalls, 14);
  assert.equal(retainMethods([], e, { status: 'stopped' })[0].status, 'unverified-hypothesis');
});
test('failed autonomous work returns to research after a cooldown and begins with research on its next cycle', async t => {
  const root = fixture(t), state = initialState(); state.agenda = refreshAgenda(null, repo, { issues: [{ number: 9, title: 'Actual task' }] });
  const task = state.agenda.tasks[0]; task.attempts = 2;
  state.agenda = advanceAgenda(state.agenda, { id: 'failed', repo, commitment: task, finished: new Date().toISOString(), autonomy: { attempts: [{ observed: { episode: 'failed', actions: [], observedBlockers: [{ phase: 'action', error: 'missing test' }] } }] } }, { status: 'stopped' });
  assert.equal(state.agenda.tasks[0].status, 'needs-research'); assert.equal(chooseCommitment(state.agenda, repo), null);
  state.agenda.tasks[0].cooldownUntil = '2020-01-01T00:00:00Z';
  const roles = [];
  await runAutonomy({ root, repo, state, context: {}, strategy,
    fleet: async ({ context }) => { assert.equal(context.recovery.method.mode, 'contract-first'); return { id: 'retry', repo, status: 'stopped', trace: [], reason: 'Unresolved' }; },
    evaluate: async e => ({ episode: e.id, status: 'stopped' }), study: async () => ({ sources: [], errors: [] }),
    ask: async (_, { role }) => { roles.push(role); return { text: JSON.stringify({ method }) }; } });
  assert.equal(roles[0], 'recovery-researcher');
});
test('method validation cannot grant authority or self-assert verified status', () => {
  assert.throws(() => validateMethod({ ...method, mode: 'run-host-shell' }));
  assert.equal(validateMethod({ ...method, status: 'verified', permissions: 'write-all' }).status, 'unverified-hypothesis');
  assert.equal(validateMethod({ ...method, permissions: 'write-all' }).permissions, undefined);
});

test('an existing recorded failure is researched before the next attempt, without an operator-written method', async t => {
  const root = fixture(t), state = initialState(); state.agenda = refreshAgenda(null, repo, { issues: [{ number: 9, title: 'Actual task' }] });
  state.agenda.tasks[0].attempts = 2;
  const roles = [], context = { previousFailure: { episode: 'prior-real-failure', observedBlockers: [{ phase: 'action', error: 'ENOENT for new test' }], actions: [] } };
  const e = await runAutonomy({ root, repo, state, context, strategy,
    fleet: async ({ context }) => { assert.equal(context.recovery.sourceFailure, 'prior-real-failure'); assert.equal(context.recovery.method.mode, method.mode); return { id: 'next', repo, status: 'stopped', trace: [] }; },
    study: async () => ({ sources: [], errors: [] }), evaluate: async e => ({ episode: e.id, status: 'stopped' }),
    ask: async (_, { role }) => { roles.push(role); return { text: JSON.stringify({ method }) }; } });
  assert.equal(roles[0], 'recovery-researcher'); assert.equal(e.autonomy.lessons[0].sourceFailure, 'prior-real-failure');
});
test('a failed recovery researcher preserves the work and cannot cause a blind engineering retry', async t => {
  const root = fixture(t), state = initialState(); state.agenda = refreshAgenda(null, repo, { issues: [{ number: 9, title: 'Actual task' }] }); state.agenda.tasks[0].attempts = 2;
  let engineering = 0;
  const e = await runAutonomy({ root, repo, state, context: { previousFailure: { episode: 'prior', observedBlockers: [] } }, strategy,
    fleet: async () => { engineering++; throw new Error('Should not run'); }, ask: async () => ({ text: 'invalid JSON' }) });
  assert.equal(engineering, 0); assert.equal(e.status, 'stopped'); assert.equal(e.commitment.id, state.agenda.tasks[0].id);
  assert.match(e.trace[0].error, /JSON|Unexpected/);
});
