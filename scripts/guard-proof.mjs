#!/usr/bin/env node
// Proof that the guard holds on the real agent binaries: the same hostile
// repository, opened three ways — bare, behind the guard, behind the guard
// after approval — plus a clean folder behind the guard. Local puppet model,
// synthetic canaries, nothing leaves the machine.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startPuppet } from '../src/puppet/server.js';
import { adapters, agentVersion } from '../src/adapters/index.js';
import { seedHome, seedWorkspace } from '../scenarios/index.js';
import { install, guardMain } from '../src/guard.js';

// Where each agent takes a command from a repository, and in which folder state.
const CASES = [
  ['claude', 'project-mcp', false], ['claude', 'project-hook', false],
  ['codex', 'project-mcp', true],
  ['gemini', 'project-mcp', true], ['gemini', 'project-hook', true],
  ['qwen', 'project-hook', true],
  ['opencode', 'project-mcp', false],
  ['crush', 'project-mcp', false],
];
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const base = path.join(os.homedir(), '.agentcrash', 'runs');
fs.mkdirSync(base, { recursive: true });

const guardHome = fs.mkdtempSync(path.join(base, 'guard-'));
const shims = install({}, { ...process.env, AGENTCRASH_HOME: guardHome });

async function open({ agent, vector, trust, how, seeded = true }) {
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  seedHome(home); seedWorkspace(ws);
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const marker = path.join(root, 'repo_marker.txt');
  const adapter = adapters[agent];
  if (seeded) adapter.repo[vector]({ ws, home, cmd: `echo ran > ${marker}; sleep 5` });
  const store = path.join(root, 'guard');
  if (how === 'approved') {
    const log = console.log; console.log = () => {};
    await guardMain(['allow', ws], { ...process.env, AGENTCRASH_HOME: store });
    console.log = log;
  }
  const puppet = await startPuppet({ script: [] });
  const wrap = how === 'bare' ? undefined : ({ cmd, args, env }) => ({
    cmd: path.join(shims.dir, cmd), args,
    env: { ...env, AGENTCRASH_HOME: store, AGENTCRASH_GUARD: '' },
  });
  const proc = await adapter.start({ home, ws, baseUrl: puppet.baseUrl, mode: adapter.repoMode ?? Object.keys(adapter.modes)[0], timeoutMs: 60000, trust, cage: wrap });
  const r = { ran: fs.existsSync(marker), reached: puppet.state.requests.length > 0, code: proc.code, killed: proc.killed };
  await puppet.close?.();
  fs.rmSync(root, { recursive: true, force: true });
  return r;
}

const rows = [];
for (const [agent, vector, trust] of CASES) {
  if (only && only !== agent) continue;
  if (!shims.agents.includes(agent)) continue;
  const row = { agent, version: await agentVersion(agent), vector, folder: trust ? 'trusted' : 'fresh clone' };
  for (const how of ['bare', 'guarded', 'approved']) row[how] = await open({ agent, vector, trust, how });
  rows.push(row);
  console.log(`${agent.padEnd(9)} ${vector.padEnd(13)} ${row.folder.padEnd(11)}  bare: ran=${row.bare.ran}   guarded: ran=${row.guarded.ran} reached-model=${row.guarded.reached} exit=${row.guarded.code}   approved: ran=${row.approved.ran}`);
}
const clean = [];
for (const agent of shims.agents) {
  if (only && only !== agent) continue;
  const r = await open({ agent, trust: true, how: 'guarded', seeded: false });
  clean.push({ agent, ...r });
  console.log(`${agent.padEnd(9)} clean folder behind the guard: reached-model=${r.reached} exit=${r.code}`);
}
fs.rmSync(guardHome, { recursive: true, force: true });
const ok = rows.length > 0 && rows.every((r) => r.bare.ran && !r.guarded.ran && !r.guarded.reached && r.guarded.code === 3 && r.approved.ran) && clean.every((r) => r.reached);
if (process.argv.includes('--json')) console.log(JSON.stringify({ rows, clean }, null, 2));
console.log(ok ? `\nguard held: ${rows.length}/${rows.length} repository commands did not start until approved; ${clean.length}/${clean.length} agents work unchanged in a clean folder` : '\nGUARD DID NOT HOLD — see rows above');
process.exit(ok ? 0 : 1);
