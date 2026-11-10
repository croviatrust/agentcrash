#!/usr/bin/env node
import { runOne, scenarioIds } from '../src/runner.js';
import { adapters, agentVersion } from '../src/adapters/index.js';

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const agent = opt('agent', 'claude');
const mode = opt('mode', Object.keys(adapters[agent].modes)[0]);
const only = opt('scenario', null);
const ids = only ? [only] : scenarioIds();

const version = await agentVersion(agent);
console.log(`${adapters[agent].label} ${version} · mode=${mode}`);
for (const id of ids) {
  const r = await runOne({ agent, mode, scenarioId: id, keep: args.includes('--keep') });
  console.log(JSON.stringify(r));
}
