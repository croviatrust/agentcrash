#!/usr/bin/env node
import fs from 'node:fs';
import { adapters, agentVersion } from '../src/adapters/index.js';
import { runOne, runRepoOne, scenarioIds, repoVectorIds } from '../src/runner.js';
import { renderTerminal, renderHtml } from '../src/report.js';
import { userConfig } from '../src/myconfig.js';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);

if (flag('help') || flag('h')) {
  console.log(`agentcrash — crash-test your coding agent against a hijacked model

Usage: agentcrash [options]
  --agent <name|all>   claude, codex, gemini, qwen, opencode, crush (default: all installed)
  --mode  <mode|all>                  permission mode (default: all)
  --scenario <id>                     run a single scenario
  --repo                              honest model, hostile repository: project config, hooks, MCP
  --my-config                         test your own agent config (permissions, tool lists, hooks, sandbox)
  --no-hooks                          with --my-config: leave your hooks out, so none of your scripts run
  --keep                              keep each run's sandbox under ~/.agentcrash/runs
  --json <file>                       write raw results as JSON
  --html <file>                       write a shareable HTML report
  --list                              list scenarios and exit
`);
  process.exit(0);
}
if (flag('list')) {
  for (const id of [...scenarioIds(), ...repoVectorIds()]) console.log(id);
  process.exit(0);
}

const wantAgent = opt('agent', 'all');
if (wantAgent !== 'all' && !adapters[wantAgent]) { console.error(`unknown agent: ${wantAgent}`); process.exit(2); }
// An agent is installed if its CLI answers --version, asked from a throwaway home.
const found = {};
for (const a of wantAgent === 'all' ? Object.keys(adapters) : [wantAgent]) {
  const v = await agentVersion(a);
  if (v === null) console.error(`skip ${a}: ${adapters[a].bin} not installed`); else found[a] = v;
}
const agents = Object.keys(found);
if (!agents.length) { console.error('no supported agent CLI found (claude, codex, gemini, qwen, opencode, crush)'); process.exit(2); }

const wantMode = opt('mode', 'all');
const only = opt('scenario', null);
// --repo swaps the hostile model for a hostile repository.
const repoMode = flag('repo') || (only && repoVectorIds().includes(only));
const ids = only ? [only] : repoMode ? repoVectorIds() : scenarioIds();

// --my-config tests the configuration you actually run with, not a default
// install. Only permission, tool-list, hook and sandbox keys are read, secrets are redacted, and
// nothing is written back to your files.
const myConfig = flag('my-config');
const keep = flag('keep');
if (myConfig) {
  console.error('--my-config: reading your real agent configuration (secrets redacted, never written back)');
  if (!flag('no-hooks')) console.error('  your hooks run as they do in every session; --no-hooks leaves them out');
}

const results = [];
const versions = [];
for (const agent of agents) {
  const v = found[agent];
  let mine;
  if (myConfig) {
    const { config, files } = userConfig(agent, undefined, { hooks: !flag('no-hooks') });
    mine = config;
    for (const f of files) console.error(`  ${agent}: ${f.file} → kept ${f.kept}`);
    if (!files.length) console.error(`  ${agent}: no project/user config found; running defaults`);
  }
  versions.push(`${adapters[agent].label} ${v}${myConfig ? ' (your config)' : ''}`);
  if (repoMode) {
    // Two columns: a folder you just cloned, and one you told the agent to trust.
    for (const trust of [false, true]) {
      for (const id of ids) {
        process.stderr.write(`\r\x1b[2K  ${agent}/${trust ? 'trusted folder' : 'fresh clone'} · ${id}`);
        results.push(await runRepoOne({ agent, vectorId: id, trust, mine, keep, mode: wantMode === 'all' ? undefined : wantMode }));
      }
    }
    continue;
  }
  // --my-config runs the agent the way you do: no mode flag, your settings decide.
  const all = Object.keys(adapters[agent].modes);
  const modes = wantMode !== 'all' ? [wantMode] : myConfig ? ['your config'] : all;
  for (const mode of modes) {
    if (!(mode in adapters[agent].modes) && !myConfig) { console.error(`skip ${agent}/${mode}: unknown mode`); continue; }
    for (const id of ids) {
      process.stderr.write(`\r\x1b[2K  ${agent}/${mode} · ${id}`);
      results.push(await runOne({ agent, mode, scenarioId: id, mine, keep }));
    }
  }
}
process.stderr.write('\r\x1b[2K');

const meta = { versions: versions.join(' · '), date: new Date().toISOString() };
console.log(renderTerminal(results, meta));
const jsonOut = opt('json', null);
if (jsonOut) { fs.writeFileSync(jsonOut, JSON.stringify({ meta, results }, null, 2)); console.error(`wrote ${jsonOut}`); }
const htmlOut = opt('html', null);
if (htmlOut) { fs.writeFileSync(htmlOut, renderHtml(results, meta)); console.error(`wrote ${htmlOut}`); }
process.exit(results.some((r) => r.verdict === 'EXPOSED') ? 1 : 0);
