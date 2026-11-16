// The guard: a shim in front of each agent CLI that reads the folder before
// the agent does. If the folder would run something in that agent, point its
// model traffic elsewhere or widen its permissions, and you have not approved
// exactly that, the agent does not start until you have seen it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { inspectDir, renderInspect, runs, MEASURED_ON } from './inspect.js';

export const AGENTS = Object.keys(MEASURED_ON);
const BIN = fileURLToPath(new URL('../bin/agentcrash.js', import.meta.url));
const MARK = '# agentcrash guard';

const root = (env = process.env) => env.AGENTCRASH_HOME || path.join(os.homedir(), '.agentcrash');
const shimDir = (env) => path.join(root(env), 'bin');
const storeFile = (env) => path.join(root(env), 'approved.json');
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

// The agent's own binary: the first one on PATH that is not our shim.
export function findReal(agent, env = process.env) {
  const mine = real(shimDir(env));
  for (const dir of (env.PATH || '').split(path.delimiter)) {
    if (!dir || real(dir) === mine) continue;
    const p = path.join(dir, agent);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (!fs.statSync(p).isFile()) continue;
      // Never hand over to another copy of the shim: that would loop.
      const fd = fs.openSync(p, 'r'), head = Buffer.alloc(64);
      fs.readSync(fd, head, 0, 64, 0); fs.closeSync(fd);
      if (!head.includes(MARK)) return p;
    } catch { /* next */ }
  }
  return null;
}

// What this folder does to this agent without the agent asking first.
export function relevant(findings, agent) {
  return findings.filter((f) => f.agent === agent && (f.when === 'open' || f.when === 'trusted') && (runs(f) || f.kind === 'redirect' || f.kind === 'permissions'));
}

// Changes when the config changes — and, for code the agent loads from the
// folder, when that code changes. Scripts a command points at are not followed.
export function fingerprint(dir, findings) {
  const parts = findings.map((f) => {
    let body = '';
    if (f.kind === 'code' && !f.command) { try { body = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f.file))).digest('hex'); } catch { /* gone */ } }
    return JSON.stringify([f.file, f.kind, f.when, f.event ?? f.name ?? f.what ?? '', f.command ?? f.url ?? [...(f.rules || []), ...(f.directories || [])], body]);
  }).sort();
  return crypto.createHash('sha256').update(parts.join('\n')).digest('hex');
}

function readStore(env) { try { return JSON.parse(fs.readFileSync(storeFile(env), 'utf8')); } catch { return {}; } }
function approve(dir, agent, fp, env) {
  const s = readStore(env);
  (s[real(dir)] ??= {})[agent] = fp;
  fs.mkdirSync(root(env), { recursive: true });
  const tmp = `${storeFile(env)}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, storeFile(env));
}

// What the guard would do for this agent in this folder, without doing it.
export function check(dir, agent, env = process.env) {
  const mine = relevant(inspectDir(dir).findings, agent);
  if (!mine.length) return { state: 'clear', findings: [] };
  const fp = fingerprint(dir, mine);
  const had = readStore(env)[real(dir)]?.[agent];
  return { state: had === fp ? 'approved' : had ? 'changed' : 'new', findings: mine, fingerprint: fp };
}

function ask(question) {
  return new Promise((resolve) => {
    process.stderr.write(question);
    process.stdin.setEncoding('utf8');
    process.stdin.resume();
    process.stdin.once('data', (d) => { process.stdin.pause(); resolve(String(d).trim().toLowerCase()); });
    process.stdin.once('end', () => resolve(''));
  });
}

function hand(cmd, args, env = process.env) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: 'inherit', env });
    const pass = (sig) => { try { child.kill(sig); } catch { /* gone */ } };
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => pass(sig));
    child.on('error', (e) => { console.error(`agentcrash guard: ${e.message}`); resolve(127); });
    child.on('exit', (code, signal) => resolve(signal ? 128 + (os.constants.signals[signal] ?? 0) : code ?? 0));
  });
}

export async function guardRun(agent, args, env = process.env) {
  const bin = findReal(agent, env);
  if (!bin) { console.error(`agentcrash guard: ${agent} is not on your PATH`); return 127; }
  const dir = process.cwd();
  let how = 'run';
  if (env.AGENTCRASH_GUARD !== 'off') {
    let c;
    try { c = check(dir, agent, env); } catch { c = { state: 'clear' }; }
    if (c.state === 'new' || c.state === 'changed') {
      const color = !!process.stderr.isTTY;
      console.error(renderInspect({ dir, findings: c.findings, unreadable: [] }, { color }).split('\n').slice(1).join('\n').replace(/\n\nMeasured on[\s\S]*$/, ''));
      console.error(`\nagentcrash guard: ${c.state === 'changed' ? 'this changed since you approved it' : 'you have not approved this'}; ${agent} has not started.`);
      const cageable = process.platform === 'linux';
      if (env.AGENTCRASH_GUARD === 'allow') how = 'run';
      else if (env.AGENTCRASH_GUARD === 'cage' && cageable) how = 'cage';
      else if (process.stdin.isTTY && process.stderr.isTTY) {
        const a = await ask(`  [r]un once   [a]lways for exactly this config${cageable ? '   [c]age: run it where there is nothing to take' : ''}   [N]o  > `);
        if (a === 'a' || a === 'always') { approve(dir, agent, c.fingerprint, env); how = 'run'; }
        else if (a === 'r' || a === 'run' || a === 'y' || a === 'yes') how = 'run';
        else if (cageable && (a === 'c' || a === 'cage')) how = 'cage';
        else return 3;
      } else {
        console.error(`  To go on: "agentcrash guard allow" in this folder approves exactly this config;\n  AGENTCRASH_GUARD=allow runs it once${cageable ? ', AGENTCRASH_GUARD=cage runs it in the roll cage' : ''}.`);
        return 3;
      }
    }
  }
  return how === 'cage'
    ? hand(process.execPath, [BIN, 'cage', '--profile', agent, '--', bin, ...args], env)
    : hand(bin, args, env);
}

const shim = (agent) => `#!/bin/sh
${MARK}: reads what this folder would start in ${agent} before ${agent} starts.
D=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [ -f ${sh(BIN)} ] && [ -x ${sh(process.execPath)} ]; then
  exec ${sh(process.execPath)} ${sh(BIN)} guard run ${agent} -- "$@"
fi
echo "agentcrash guard: agentcrash is gone from ${BIN}; starting ${agent} unguarded" >&2
PATH=$(printf '%s' "$PATH" | tr ':' '\\n' | grep -vxF "$D" | paste -sd: -)
exec ${agent} "$@"
`;
const sh = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const rcLine = (env) => `export PATH=${JSON.stringify(shimDir(env))}:"$PATH" ${MARK}`;
const rcFiles = () => ['.bashrc', '.zshrc'].map((f) => path.join(os.homedir(), f)).filter((f) => fs.existsSync(f));

export function install({ rc = false } = {}, env = process.env) {
  if (process.platform === 'win32') throw new Error('the guard needs a POSIX shell');
  const dir = shimDir(env);
  fs.mkdirSync(dir, { recursive: true });
  const done = [];
  for (const agent of AGENTS) {
    if (!findReal(agent, env)) continue;
    fs.writeFileSync(path.join(dir, agent), shim(agent), { mode: 0o755 });
    fs.chmodSync(path.join(dir, agent), 0o755);
    done.push(agent);
  }
  const wrote = [];
  if (rc) {
    for (const f of rcFiles()) {
      const text = fs.readFileSync(f, 'utf8');
      if (text.includes(MARK)) continue;
      fs.writeFileSync(f, `${text}${text.endsWith('\n') ? '' : '\n'}${rcLine(env)}\n`);
      wrote.push(f);
    }
  }
  return { dir, agents: done, rc: wrote, line: rcLine(env) };
}

export function uninstall(env = process.env) {
  const dir = shimDir(env);
  const gone = [];
  for (const agent of AGENTS) {
    const p = path.join(dir, agent);
    try { if (fs.readFileSync(p, 'utf8').includes(MARK)) { fs.unlinkSync(p); gone.push(agent); } } catch { /* not there */ }
  }
  const rc = [];
  for (const f of rcFiles()) {
    const text = fs.readFileSync(f, 'utf8');
    if (!text.includes(MARK)) continue;
    fs.writeFileSync(f, text.split('\n').filter((l) => !l.includes(MARK)).join('\n'));
    rc.push(f);
  }
  return { agents: gone, rc };
}

const HELP = `agentcrash guard — the agent does not start in a folder until you have seen what the folder starts in it

  agentcrash guard install [--rc]  put a shim in front of every agent CLI on your PATH
                                   (--rc adds the PATH line to ~/.bashrc and ~/.zshrc for you)
  agentcrash guard uninstall       take the shims, and that line, away again
  agentcrash guard status [dir]    what each agent would be stopped for in this folder
  agentcrash guard allow [dir]     approve exactly the config that is there now

A folder with nothing to run costs you nothing: the agent starts as always. A folder whose config
starts a command, loads code, moves your model traffic or widens permissions stops once, shows you
what, and asks. Approval is for that exact config: when a pull changes it, you are asked again.
AGENTCRASH_GUARD=off|allow|cage overrides the question for one run.`;

export async function guardMain(argv, env = process.env) {
  const [sub, ...rest] = argv;
  if (sub === 'run') {
    const at = rest.indexOf('--');
    return guardRun(rest[0], at >= 0 ? rest.slice(at + 1) : rest.slice(1), env);
  }
  if (sub === 'install') {
    const r = install({ rc: rest.includes('--rc') }, env);
    if (!r.agents.length) { console.log('agentcrash guard: none of claude, codex, gemini, qwen, opencode, crush is on your PATH'); return 1; }
    console.log(`agentcrash guard: in front of ${r.agents.join(', ')} (${r.dir})`);
    if (r.rc.length) console.log(`  PATH line added to ${r.rc.join(', ')}; open a new shell`);
    else if ((env.PATH || '').split(path.delimiter).map(real)[0] !== real(r.dir)) console.log(`  Put it first on your PATH — add this to your shell profile, or run install --rc:\n    ${r.line}`);
    return 0;
  }
  if (sub === 'uninstall') {
    const r = uninstall(env);
    console.log(`agentcrash guard: removed ${r.agents.length ? r.agents.join(', ') : 'nothing'}${r.rc.length ? `; PATH line removed from ${r.rc.join(', ')}` : ''}`);
    return 0;
  }
  if (sub === 'status' || sub === 'allow') {
    const dir = rest.find((a) => !a.startsWith('--')) ?? '.';
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { console.error(`agentcrash guard: ${dir} is not a directory`); return 2; }
    let stopped = 0;
    for (const agent of AGENTS) {
      const c = check(dir, agent, env);
      if (c.state === 'clear') continue;
      if (sub === 'allow') { approve(dir, agent, c.fingerprint, env); console.log(`${MEASURED_ON[agent].replace(/ [\d.]+$/, '')}: approved ${c.findings.length} thing(s) this folder does`); continue; }
      if (c.state !== 'approved') stopped++;
      console.log(`${agent.padEnd(9)} ${c.state === 'approved' ? 'approved' : c.state === 'changed' ? 'CHANGED since approval' : 'NOT APPROVED'}  ${c.findings.length} thing(s)`);
    }
    if (sub === 'status' && !stopped) console.log('agentcrash guard: nothing in this folder would stop an agent');
    return sub === 'status' && stopped ? 1 : 0;
  }
  console.log(HELP);
  return sub === '--help' || sub === 'help' || !sub ? 0 : 2;
}
