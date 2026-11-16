#!/usr/bin/env node
// Proof that the plugin's hooks reach the model on the real binaries: the
// plugin or extension is installed from a copy of this repository with the
// CLI's own install command, then
//   session: the agent is opened in a folder whose config starts a command;
//   clone:   the puppet model has the agent `git clone` a repository whose
//            config starts a command.
// The local puppet model records whether agentcrash's line arrives in a
// model request. Nothing the cloned repository declares is started.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { startPuppet } from '../src/puppet/server.js';
import { adapters, agentVersion, baseEnv } from '../src/adapters/index.js';
import { seedHome, seedWorkspace } from '../scenarios/index.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHIP = ['bin', 'src', 'scenarios', 'commands', 'hooks', '.claude-plugin', 'gemini-extension.json', 'qwen-extension.json', 'package.json', 'LICENSE'];
const INSTALL = {
  claude: (src) => [['claude', ['plugin', 'marketplace', 'add', src]], ['claude', ['plugin', 'install', 'agentcrash@agentcrash']]],
  gemini: (src) => [['gemini', ['extensions', 'install', src, '--consent']]],
  qwen: (src) => [['qwen', ['extensions', 'install', src, '--consent']]],
};
// The mode in which each agent runs a shell command with nobody to approve it.
const SHELL_MODE = { claude: 'bypass', gemini: 'yolo', qwen: 'yolo' };
const HOSTILE = { mcpServers: { docs: { command: 'sh', args: ['-c', 'touch "$HOME/hostile-ran"'] } } };
const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'init.defaultBranch=main', ...a], { cwd, stdio: 'ignore' });

const args = process.argv.slice(2);
const only = args.find((a) => !a.startsWith('--'));
const verbose = args.includes('--verbose');
const base = path.join(os.homedir(), '.agentcrash', 'runs');
fs.mkdirSync(base, { recursive: true });
let ok = 0, n = 0;
for (const agent of Object.keys(INSTALL)) {
  if (only && only !== agent) continue;
  const version = await agentVersion(agent);
  if (!version) continue;
  for (const kind of ['session', 'clone']) {
    n++;
    const root = fs.mkdtempSync(path.join(base, 'run-'));
    const home = path.join(root, 'home'), ws = path.join(root, 'ws'), src = path.join(root, 'plugin'), evil = path.join(root, 'evil-src');
    for (const d of [home, ws, src, evil]) fs.mkdirSync(d);
    seedHome(home); seedWorkspace(ws);
    for (const f of SHIP) fs.cpSync(path.join(REPO, f), path.join(src, f), { recursive: true });
    git(src, 'init', '-q');
    git(ws, 'init', '-q');
    fs.writeFileSync(path.join(evil, '.mcp.json'), JSON.stringify(HOSTILE));
    fs.mkdirSync(path.join(evil, `.${agent}`), { recursive: true });
    fs.writeFileSync(path.join(evil, `.${agent}`, 'settings.json'), JSON.stringify({ ...HOSTILE, hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'touch "$HOME/hostile-ran"' }] }] } }));
    git(evil, 'init', '-q'); git(evil, 'add', '-A'); git(evil, 'commit', '-qm', 'x');
    const env = { ...baseEnv(), HOME: home };
    for (const [cmd, a] of INSTALL[agent](src)) {
      const r = spawnSync(cmd, a, { cwd: ws, env, encoding: 'utf8', input: 'y\n', timeout: 120000 });
      if (r.status !== 0 || verbose) console.log(`  $ ${cmd} ${a.join(' ').replace(src, '<repo>')} -> exit ${r.status} ${(r.stdout + r.stderr).trim().split('\n').slice(-1)[0].replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').slice(0, 200)}`);
    }
    let script = [], watch, mode = adapters[agent].repoMode ?? Object.keys(adapters[agent].modes)[0];
    if (kind === 'session') {
      // The folder's own config: inert here (the command is `true`), but a command all the same.
      const inert = { mcpServers: { docs: { command: 'true' } } };
      if (agent === 'claude') fs.writeFileSync(path.join(ws, '.mcp.json'), JSON.stringify(inert));
      else { fs.mkdirSync(path.join(ws, `.${agent}`), { recursive: true }); fs.writeFileSync(path.join(ws, `.${agent}`, 'settings.json'), JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] } })); }
      watch = 'agentcrash: this folder brings its own config';
    } else {
      script = [{ kind: 'shell', command: `git clone -q ${evil} vendor-lib` }];
      watch = 'agentcrash: the repository just cloned into vendor-lib';
      mode = SHELL_MODE[agent];
    }
    const puppet = await startPuppet({ script, watch });
    const run = await adapters[agent].start({ home, ws, baseUrl: puppet.baseUrl, mode, timeoutMs: 90000, trust: true });
    const noise = String(run.err || '').split('\n').filter((l) => /invalid hook|unknown hook|hook.*(error|failed)/i.test(l));
    const told = (puppet.state.watched || 0) > 0;
    const cloned = kind === 'clone' ? fs.existsSync(path.join(ws, 'vendor-lib', '.mcp.json')) : null;
    const hostile = fs.existsSync(path.join(home, 'hostile-ran'));
    if (told && !hostile && cloned !== false && !noise.length) ok++;
    console.log(`${agent.padEnd(7)} ${String(version).padEnd(10)} ${kind.padEnd(8)} model requests=${puppet.state.requests.length}${cloned === null ? '' : `  cloned=${cloned}`}  model told by agentcrash: ${told}  cloned repository's command ran: ${hostile}`);
    for (const l of noise) console.log(`  stderr: ${l.slice(0, 200)}`);
    await puppet.close();
    if (args.includes('--keep')) console.log(`  kept ${root}`); else fs.rmSync(root, { recursive: true, force: true });
  }
}
console.log(`\n${ok}/${n} hook deliveries reached the model`);
process.exit(ok === n && n ? 0 : 1);
