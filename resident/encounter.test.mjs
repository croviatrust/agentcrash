import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTask, grade, inspectTool, encounter, encounterSummary } from './encounter.mjs';
import { initialState, remember, json } from './core.mjs';
import { runFleet } from './fleet.mjs';
import { verify } from './verify.mjs';
import { makeCapsule } from './learning.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
const strategy = json(new URL('./strategy.json', import.meta.url));
function temp(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crovia-enc-test-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }
// Test double solves the small fixture; this does not measure LLM ability.
function scriptedVisitor() {
  return async (messages, { role }) => {
    assert.ok(!messages[1].content.includes('expected'));
    const actions = messages.filter(m => m.role === 'assistant').map(m => JSON.parse(m.content).action);
    let action;
    if (role.endsWith('catalog-available') && !actions.includes('discover')) action = { action: 'discover' };
    else if (role.endsWith('catalog-available') && !actions.includes('tool')) action = { action: 'tool', name: 'inspect_repository' };
    else if (!role.endsWith('catalog-available') && !actions.includes('read')) action = { action: 'read', paths: ['.mcp.json', '.claude/settings.json'] };
    else {
      const observed = JSON.parse(messages.filter(m => m.role === 'user' && m.content.includes('"observed"')).at(-1).content).observed;
      let commands = [], endpoints = [];
      if (Array.isArray(observed)) {
        const mcp = JSON.parse(observed.find(f => f.path === '.mcp.json').content);
        const claude = JSON.parse(observed.find(f => f.path === '.claude/settings.json').content);
        commands = [...Object.values(mcp.mcpServers).map(s => [s.command, ...s.args].join(' ')), ...(claude.hooks?.SessionStart || []).flatMap(h => h.hooks.map(v => v.command))];
        if (claude.env?.ANTHROPIC_BASE_URL) endpoints.push(claude.env.ANTHROPIC_BASE_URL);
      } else {
        commands = observed.findings.filter(f => f.command).map(f => f.command);
        endpoints = observed.findings.filter(f => f.kind === 'redirect').map(f => f.url);
      }
      action = { action: 'finish', commands, endpoints };
    }
    return { text: JSON.stringify(action), model: 'test-double' };
  };
}
test('actual inspection CLI matches the independent configured and benign fixture contracts', t => {
  for (const variant of ['configured', 'benign']) {
    const root = temp(t), task = createTask(root, { variant, token: 'proof' });
    const { output, evidence } = inspectTool(project, root);
    const answer = { commands: output.findings.filter(f => f.command).map(f => f.command), endpoints: output.findings.filter(f => f.kind === 'redirect').map(f => f.url) };
    assert.equal(grade(answer, task.expected).correct, true);
    assert.equal(evidence.exit, variant === 'configured' ? 1 : 0);
    assert.equal(fs.existsSync(path.join(root, 'tools')), false); // Configured commands were not executed.
  }
});
test('grading rejects self-reported success, omissions and false positives', () => {
  const expected = { commands: ['node start.mjs'], endpoints: [] };
  assert.equal(grade({ success: true }, expected).correct, false);
  const score = grade({ commands: ['npm run build'], endpoints: [] }, expected);
  assert.deepEqual(score.missing.commands, ['node start.mjs']); assert.deepEqual(score.extra.commands, ['npm run build']);
  assert.equal(grade({ commands: [' node start.mjs ', 'node start.mjs'], endpoints: [] }, expected).correct, true);
});
test('fresh controlled cohorts use actual tool output and preserve trace evidence, not adoption claims', async () => {
  for (const variant of ['configured', 'benign']) {
    const report = await encounter({ project, variant, ask: scriptedVisitor() });
    assert.equal(report.cohorts.length, 2); assert.ok(report.cohorts.every(c => c.messages[1].role === 'user')); assert.match(report.catalogHash, /^[a-f0-9]{64}$/); assert.ok(report.cohorts.every(c => c.score.correct));
    const available = report.cohorts.find(c => c.cohort === 'catalog-available');
    assert.equal(available.toolCalls, 1); assert.match(available.trace.find(t => t.execution).execution.sha256, /^[a-f0-9]{64}$/);
    assert.equal(report.cohorts.find(c => c.cohort === 'files-only').toolCalls, 0);
    assert.match(report.limits.join(' '), /not public discovery/);
    const summary = encounterSummary(report); assert.equal(JSON.stringify(summary).includes('observed'), false);
  }
});
test('unlisted reads, undiscovered tools and inference errors are bounded and visible', async () => {
  let calls = 0;
  const report = await encounter({ project, variant: 'benign', ask: async (_, { role }) => {
    calls++;
    if (calls % 3 === 0) throw new Error('inference unavailable');
    return { text: JSON.stringify(role.endsWith('files-only') ? { action: 'read', paths: ['../../.env'] } : { action: 'tool', name: 'inspect_repository' }) };
  } });
  assert.equal(calls, 8); assert.ok(report.cohorts.every(c => !c.score.completed && !c.toolCalls));
  assert.ok(report.cohorts.some(c => c.trace.some(t => t.phase === 'inference' && t.error)));
});
test('encounter cycles persist compact obstacles for engineering and cannot become repair capsules', async () => {
  const state = initialState();
  const episode = await runFleet({ root: project, repo: 'croviatrust/agentcrash', state, context: {}, strategy, enableEncounters: true, ask: scriptedVisitor() });
  assert.equal(episode.kind, 'encounter'); assert.equal(episode.proposal, undefined);
  const verdict = await verify(project, episode); assert.equal(verdict.status, 'stopped'); assert.equal(makeCapsule(episode, verdict), null);
  const saved = remember(state, episode); assert.equal(saved.lastEncounter.id, episode.encounter.id);
  assert.equal(saved.recent[0].encounter, undefined); assert.equal(saved.recent[0].encounterSummary.id, episode.encounter.id);
  let received = false;
  const next = await runFleet({ root: project, repo: 'croviatrust/agentcrash', state: saved, context: { latestEncounter: saved.lastEncounter }, strategy,
    enableEncounters: true, study: async () => ({ sources: [], errors: [] }), ask: async (messages, { role }) => {
      if (role === 'scout') { received = JSON.stringify(messages).includes(saved.lastEncounter.id); return { text: '{"mission":"Investigate the measured encounter obstacle"}' }; }
      return { text: role === 'critic' ? '{"decision":"revise","reason":"Need more evidence"}' : '{"action":"stop","reason":"Need a reproducible repair"}' };
    } });
  assert.ok(received); assert.notEqual(next.kind, 'encounter');
});
