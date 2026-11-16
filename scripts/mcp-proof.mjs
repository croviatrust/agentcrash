#!/usr/bin/env node
// Proof that `agentcrash mcp` is a server the real agent binaries accept: each
// one is given it in its own config, and the local puppet model records
// whether the inspect_repository tool then arrives in the model request.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { startPuppet } from '../src/puppet/server.js';
import { adapters, agentVersion } from '../src/adapters/index.js';
import { seedHome, seedWorkspace } from '../scenarios/index.js';

const BIN = fileURLToPath(new URL('../bin/agentcrash.js', import.meta.url));
const cmd = [process.execPath, BIN, 'mcp'];
const json = (file, body) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(body)); };
const std = { mcpServers: { agentcrash: { command: cmd[0], args: cmd.slice(1) } } };
// How each agent is told about a stdio MCP server.
const WIRE = {
  claude: ({ ws }) => json(path.join(ws, '.mcp.json'), std),
  codex: ({ ws }) => { fs.mkdirSync(path.join(ws, '.codex')); fs.writeFileSync(path.join(ws, '.codex/config.toml'), `[mcp_servers.agentcrash]\ncommand = ${JSON.stringify(cmd[0])}\nargs = ${JSON.stringify(cmd.slice(1))}\n`); },
  gemini: ({ ws }) => json(path.join(ws, '.gemini/settings.json'), std),
  qwen: () => ({ '.qwen/settings.json': std }),
  opencode: ({ ws }) => json(path.join(ws, 'opencode.json'), { mcp: { agentcrash: { type: 'local', command: cmd, enabled: true } } }),
  crush: ({ ws }) => json(path.join(ws, 'crush.json'), { mcp: { agentcrash: { type: 'stdio', command: cmd[0], args: cmd.slice(1) } } }),
};
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
const base = path.join(os.homedir(), '.agentcrash', 'runs');
fs.mkdirSync(base, { recursive: true });
let ok = 0, n = 0;
for (const agent of Object.keys(WIRE)) {
  if (only && only !== agent) continue;
  const version = await agentVersion(agent);
  if (!version) continue;
  n++;
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  seedHome(home); seedWorkspace(ws);
  execFileSync('git', ['init', '-q'], { cwd: ws });
  const mine = WIRE[agent]({ ws, home }) ?? {};
  const puppet = await startPuppet({ script: [], watch: 'inspect_repository' });
  const adapter = adapters[agent];
  await adapter.start({ home, ws, baseUrl: puppet.baseUrl, mode: adapter.repoMode ?? Object.keys(adapter.modes)[0], timeoutMs: 60000, trust: true, mine });
  const offered = (puppet.state.watched || 0) > 0;
  if (offered) ok++;
  console.log(`${agent.padEnd(9)} ${String(version).padEnd(12)} model requests=${puppet.state.requests.length}  inspect_repository offered to the model: ${offered}`);
  await puppet.close();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(`\n${ok}/${n} agents put inspect_repository in front of their model`);
process.exit(ok === n && n ? 0 : 1);
