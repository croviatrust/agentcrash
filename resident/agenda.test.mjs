import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshAgenda, chooseCommitment, advanceAgenda } from './agenda.mjs';
import { runFleet } from './fleet.mjs';
import { initialState, json } from './core.mjs';
import { fileURLToPath } from 'node:url';
const repo = 'croviatrust/agentcrash';
const context = { issues: [{ number: 42, title: 'Repair a reproducible startup failure', body: 'Observed behavior' }] };
const seed = () => refreshAgenda(null, repo, context);
function attempt(agenda, extra = {}) {
  const t = agenda.tasks[0];
  return advanceAgenda(agenda, { id: 'run', repo, commitment: { id: t.id, evidenceHash: t.evidenceHash }, next: 'Test the actual startup path', ...extra }, { status: 'stopped' });
}
test('commitments and checkpoints survive process-state serialization and preserve stable identities', () => {
  const first = seed(), id = first.tasks[0].id;
  const second = refreshAgenda(JSON.parse(JSON.stringify(attempt(first))), repo, context);
  assert.equal(chooseCommitment(second, repo).id, id); assert.equal(second.tasks[0].attempts, 1);
  assert.equal(second.tasks[0].next, 'Test the actual startup path'); assert.equal(first.tasks[0].attempts, 0);
});
test('three inconclusive attempts block work instead of recreating the same mission every cycle', () => {
  let agenda = seed(); for (let i = 0; i < 3; i++) agenda = attempt(agenda);
  assert.equal(agenda.tasks[0].status, 'blocked'); assert.equal(chooseCommitment(agenda, repo), null);
  assert.equal(refreshAgenda(agenda, repo, context).tasks[0].status, 'blocked');
  const changed = refreshAgenda(agenda, repo, { issues: [{ ...context.issues[0], body: 'New reproduction evidence' }] });
  assert.equal(changed.tasks[0].status, 'queued'); assert.equal(changed.tasks[0].attempts, 0);
});
test('candidate publication waits for review; only actual merge reconciliation completes the patch', () => {
  const agenda = attempt(seed(), { status: 'awaiting-crovia-identity', url: 'https://github.com/croviatrust/agentcrash/compare/candidate' });
  assert.equal(agenda.tasks[0].status, 'awaiting-review'); assert.equal(chooseCommitment(agenda, repo), null);
  agenda.tasks[0].pr = 99;
  const merged = refreshAgenda(agenda, repo, context, { 99: 'merged' });
  assert.equal(merged.tasks[0].status, 'completed'); assert.match(merged.tasks[0].completion, /adoption remain unmeasured/);
  assert.equal(refreshAgenda(agenda, repo, context, { 99: 'rejected' }).tasks[0].status, 'rejected');
});
test('stale evidence and foreign-repository episodes cannot advance a commitment', () => {
  const agenda = seed(), t = agenda.tasks[0];
  for (const extra of [{ repo: 'croviatrust/causari', commitment: t }, { repo, commitment: { ...t, evidenceHash: 'stale' } }])
    assert.deepEqual(advanceAgenda(agenda, extra, { status: 'verified' }), agenda);
});
test('source refresh cannot reset a candidate already awaiting review and missing search results do not close work', () => {
  const agenda = attempt(seed(), { status: 'pr-blocked' });
  assert.equal(refreshAgenda(agenda, repo, { issues: [{ ...context.issues[0], body: 'Changed' }] }).tasks[0].status, 'awaiting-review');
  assert.equal(refreshAgenda(seed(), repo, {}).tasks[0].status, 'queued');
});
test('an assigned persistent objective reaches scout and builder instead of being lost between runs', async () => {
  const state = initialState(); state.agenda = attempt(seed()); let scout = false, builder = false;
  const e = await runFleet({ root: fileURLToPath(new URL('../', import.meta.url)), repo, state, context: {}, strategy: json(new URL('./strategy.json', import.meta.url)),
    study: async () => ({ sources: [], errors: [] }), ask: async (messages, { role }) => {
      if (role === 'scout') { scout = JSON.stringify(messages).includes('Test the actual startup path'); return { text: '{"mission":"Test startup ordering"}' }; }
      if (role !== 'critic') builder = JSON.stringify(messages).includes(state.agenda.tasks[0].id);
      return { text: role === 'critic' ? '{"decision":"revise","reason":"Need reproduction"}' : '{"action":"stop","reason":"Need evidence","next":"Inspect startup ordering"}' };
    } });
  assert.ok(scout && builder); assert.equal(e.commitment.id, state.agenda.tasks[0].id);
});

test('a trusted assignment selects its actual issue ahead of existing work without reviving exhausted tasks', () => {
  const old = refreshAgenda(null, repo, { issues: [{ number: 1, title: 'Older work' }] });
  const supplied = { ...context, maintainerAssignment: { issueNumber: 42 } };
  const agenda = refreshAgenda(old, repo, supplied);
  assert.equal(chooseCommitment(agenda, repo).source, `https://github.com/${repo}/issues/42`);
  agenda.tasks[0].status = 'blocked';
  assert.equal(chooseCommitment(refreshAgenda(agenda, repo, supplied), repo).source, `https://github.com/${repo}/issues/1`);
  assert.equal(refreshAgenda(old, repo, { maintainerAssignment: { issueNumber: 999 } }).tasks.length, 1);
});

test('a direct active maintainer assignment takes precedence over a routine encounter cycle', async () => {
  const state = initialState(); state.generation = 3; state.agenda = seed();
  const e = await runFleet({ root: fileURLToPath(new URL('../', import.meta.url)), repo, state,
    context: { maintainerAssignment: { issueNumber: 42 } }, enableEncounters: true,
    strategy: json(new URL('./strategy.json', import.meta.url)), study: async () => ({ sources: [], errors: [] }),
    ask: async (_, { role }) => ({ text: role === 'scout' ? '{"mission":"Reproduce the assigned defect"}' : role === 'critic' ? '{"decision":"revise","reason":"Need reproduction"}' : '{"action":"stop","reason":"Checkpoint"}' }) });
  assert.notEqual(e.kind, 'encounter'); assert.equal(e.commitment.id, state.agenda.tasks[0].id);
});

test('a changed checkout allows research without erasing failure history or exceeding recovery limits', () => {
  const a=seed(), task=a.tasks[0]; Object.assign(task,{status:'needs-research',attempts:3,recoveryCycles:1,lastFailure:{baseSHA:'old'},cooldownUntil:new Date(Date.now()+600000).toISOString()});
  assert.equal(chooseCommitment(refreshAgenda(a,repo,{...context,revision:'old'}),repo),null);
  const changed=refreshAgenda(a,repo,{...context,revision:'new'});
  assert.equal(chooseCommitment(changed,repo).id,task.id); assert.equal(changed.tasks[0].attempts,3); assert.equal(changed.tasks[0].recoveryCycles,1);
  task.recoveryCycles=6;
  assert.equal(chooseCommitment(refreshAgenda(a,repo,{...context,revision:'new'}),repo),null);
});
