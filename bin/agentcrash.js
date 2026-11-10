#!/usr/bin/env node
import fs from 'node:fs';
import { adapters, agentVersion } from '../src/adapters/index.js';
import { runOne, scenarioIds } from '../src/runner.js';
import { renderTerminal, renderHtml } from '../src/report.js';
import { spawnSync } from 'node:child_process';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes(`--${name}`);

if (flag('help') || flag('h')) {
  console.log(`agentcrash — crash-test your coding agent against a hijacked model

Usage: agentcrash [options]
  --agent <name|all>   claude, codex, gemini, qwen, opencode, crush (default: all installed)
  --mode  <mode|all>                  permission mode (default: all)
  --scenario <id>                     run a single scenario
  --json <file>                       write raw results as JSON
  --html <file>                       write a shareable HTML report
  --list                              list scenarios and exit
`);
  process.exit(0);
}
if (flag('list')) { for (const id of scenarioIds()) console.log(id); process.exit(0); }

const installed = (bin) => spawnSync(bin, ['--version'], { stdio: 'ignore' }).status === 0;
const wantAgent = opt('agent', 'all');
const agents = (wantAgent === 'all' ? Object.keys(adapters) : [wantAgent]).filter((a) => {
  if (!adapters[a]) { console.error(`unknown agent: ${a}`); process.exit(2); }
  if (!installed(adapters[a].bin)) { console.error(`skip ${a}: ${adapters[a].bin} not installed`); return false; }
  return true;
});
if (!agents.length) { console.error('no supported agent CLI found (claude, codex, gemini, qwen, opencode, crush)'); process.exit(2); }

const wantMode = opt('mode', 'all');
const only = opt('scenario', null);
const ids = only ? [only] : scenarioIds();

const results = [];
const versions = [];
for (const agent of agents) {
  const v = await agentVersion(agent);
  versions.push(`${adapters[agent].label} ${v}`);
  const modes = wantMode === 'all' ? Object.keys(adapters[agent].modes) : [wantMode];
  for (const mode of modes) {
    if (!(mode in adapters[agent].modes)) { console.error(`skip ${agent}/${mode}: unknown mode`); continue; }
    for (const id of ids) {
      process.stderr.write(`\r\x1b[2K  ${agent}/${mode} · ${id}`);
      results.push(await runOne({ agent, mode, scenarioId: id }));
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
