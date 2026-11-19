#!/usr/bin/env node
// Keeps the record (record/runs) in step with what the agents ship.
//
//   node scripts/record.mjs plan [--force]
//       Are the installed agents, or the tests themselves, different from the
//       last run on record? Prints why, and in a workflow sets `changed`.
//
//   node scripts/record.mjs import out.json --suite model|repo [--cage]
//         [--source-kind ci|reproduction|published] [--source "who ran it, where"] [--url https://…]
//         [--note "one sentence" [--note-agent crush] [--note-url https://…]]
//       Turns the output of `agentcrash --json out.json` into one run of the
//       record. A run that is missing an agent, or whose caged half did not
//       run, is refused: `--allow "reason"` writes it anyway, with the reason.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AGENTS, SUITES, agentLabel, normalize, problems, runsOf } from '../record/lib/core.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const RUNS = path.join(ROOT, 'record', 'runs');
const argv = process.argv.slice(2);
const opt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const flag = (k) => argv.includes(`--${k}`);

const load = () => fs.readdirSync(RUNS).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(RUNS, f), 'utf8')));

// The tests are the code that runs them: a change there can move a verdict
// as surely as a release can, so it is part of what a run is.
export function rigHash() {
  const h = crypto.createHash('sha256');
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else { h.update(path.relative(ROOT, p)); h.update('\0'); h.update(fs.readFileSync(p)); h.update('\0'); }
    }
  };
  for (const d of ['bin', 'scenarios', 'src']) walk(path.join(ROOT, d));
  return h.digest('hex').slice(0, 12);
}

function commit() {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 7);
  const r = spawnSync('git', ['rev-parse', '--short=7', 'HEAD'], { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : null;
}

async function plan() {
  const { agentVersion } = await import('../src/adapters/index.js');
  const installed = {};
  for (const a of Object.keys(AGENTS)) installed[a] = await agentVersion(a);
  const missing = Object.keys(AGENTS).filter((a) => installed[a] === null);
  if (missing.length) { console.error(`not installed: ${missing.map(agentLabel).join(', ')}. The record is of all six; nothing is measured without them.`); process.exit(1); }

  const runs = load();
  const rig = rigHash();
  const why = [];
  for (const suite of SUITES) {
    const last = runsOf(runs, suite).at(-1);
    if (!last) { why.push(`${suite}: no run on record`); continue; }
    for (const a of Object.keys(AGENTS)) if (last.versions[a] !== installed[a]) why.push(`${suite}: ${agentLabel(a)} ${last.versions[a] ?? 'not measured'} → ${installed[a]}`);
    if (last.rigHash !== rig) why.push(`${suite}: the tests changed since ${last.rig ?? 'the last run'}`);
  }
  if (flag('force') && !why.length) why.push('asked for (--force)');
  console.log(Object.entries(installed).map(([a, v]) => `${agentLabel(a)} ${v}`).join(' · '));
  console.log(why.length ? `run: ${[...new Set(why)].join('; ')}` : 'nothing to run: the same versions and the same tests as the last run on record');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `changed=${why.length ? 'true' : 'false'}\n`);
}

function importRun() {
  const file = argv.find((a, i) => i > 0 && !a.startsWith('--') && !(argv[i - 1] || '').startsWith('--'));
  if (!file) { console.error('usage: record.mjs import <agentcrash.json> --suite model|repo [--cage] [--source-kind …] [--source …] [--url …]'); process.exit(2); }
  const note = opt('note');
  const run = normalize(JSON.parse(fs.readFileSync(file, 'utf8')), {
    suite: opt('suite'), rig: commit(), rigHash: rigHash(),
    source: { kind: opt('source-kind'), text: opt('source'), url: opt('url') },
    notes: note ? [{ ...(opt('note-agent') ? { agent: opt('note-agent') } : {}), text: note, ...(opt('note-url') ? { url: opt('note-url') } : {}) }] : [],
  });
  const wrong = problems(run, { cage: flag('cage') });
  if (wrong.length) {
    for (const w of wrong) console.error(`refused: ${w}`);
    if (!opt('allow')) process.exit(1);
    run.notes = [...(run.notes ?? []), { text: `Recorded although: ${wrong.join('; ')}. ${opt('allow')}` }];
  }
  fs.mkdirSync(RUNS, { recursive: true });
  const out = path.join(RUNS, `${run.suite}-${run.id}.json`);
  fs.writeFileSync(out, `${JSON.stringify(run, null, 1)}\n`);
  console.log(`wrote ${path.relative(ROOT, out)}: ${run.results.length} results`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (argv[0] === 'plan') await plan();
    else if (argv[0] === 'import') importRun();
    else { console.error('usage: record.mjs plan [--force] | import <agentcrash.json> --suite model|repo …'); process.exit(2); }
  } catch (e) { console.error(`record: ${e.message}`); process.exit(1); }
}
