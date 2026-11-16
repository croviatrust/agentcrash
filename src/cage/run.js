// `agentcrash cage -- <agent command>`: your real agent, your real account,
// inside the roll cage.
import { inspectDir, runs } from '../inspect.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { startGate } from './gate.js';
import { cage, cageAvailable, PROFILES } from './index.js';
import { snapshot, changes, undo } from './snapshot.js';

// Package registries: read-mostly, and what an agent needs to install things.
const REGISTRIES = ['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io', 'index.crates.io', 'proxy.golang.org', 'sum.golang.org'];

export const CAGE_HELP = `agentcrash cage — run your coding agent where a hijacked model has nothing to take

Usage: agentcrash cage [options] -- <agent command> [args...]
       agentcrash cage --undo      put back what the last session here deleted or changed
       agentcrash cage --changes   list what the last session here touched
  e.g. agentcrash cage -- claude
       agentcrash cage --registries --allow api.mycompany.dev -- codex

Inside the cage:
  home        empty, except the agent's own state, your toolchains and ~/.gitconfig
  workspace   the current directory, writable; .git read-only; .env files read as empty
  environment an allow-list plus the agent's own variables
  network     none, except a proxy that only dials the agent's model hosts
  undo        the workspace is recorded before each session, outside the cage

  --allow <host[:port]>   also let this host through (repeatable; *.example.com for subdomains)
  --registries            also allow npm, PyPI, crates.io and the Go proxy
  --local <port>          also reach this port of your own machine (a local model server; repeatable)
  --rw <path>             also make this path writable (repeatable)
  --ro <path>             also show this path read-only (repeatable)
  --env <NAME>            also pass this environment variable (repeatable)
  --git-write             let the agent commit (.git/hooks and .git/config stay read-only)
  --show-env              leave .env files readable
  --open-net              do not cage the network
  --no-snapshot           do not record the workspace first
  --profile <agent>       claude, codex, gemini, qwen, opencode, crush (default: from the command name)
  --print                 print the bubblewrap command instead of running it

Linux only for now (bubblewrap). The agent's own credential stays reachable: it cannot work without it.
`;

export async function cageMain(argv) {
  const dash = argv.indexOf('--');
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const command = dash >= 0 ? argv.slice(dash + 1) : [];
  const flag = (n) => own.includes(`--${n}`);
  const many = (n) => own.flatMap((a, i) => (a === `--${n}` && own[i + 1] ? [own[i + 1]] : []));
  const list = (label, files) => { if (files.length) console.error(`  ${label}: ${files.slice(0, 20).join(', ')}${files.length > 20 ? `, … ${files.length - 20} more` : ''}`); };
  if (flag('undo') || flag('changes')) {
    let r;
    try { r = flag('undo') ? undo(process.cwd()) : changes(process.cwd()); } catch (e) { console.error(`agentcrash cage: ${e.message}`); return 2; }
    if (!r) { console.error('agentcrash cage: no session was recorded for this directory'); return 2; }
    const n = r.deleted.length + r.changed.length;
    console.error(flag('undo') ? `agentcrash cage: put back ${n} file(s)` : `agentcrash cage: ${n + r.added.length} file(s) differ from the start of the last session`);
    list(flag('undo') ? 'restored (were deleted)' : 'deleted', r.deleted);
    list(flag('undo') ? 'restored (were changed)' : 'changed', r.changed);
    list(flag('undo') ? 'added by the session, left in place' : 'added', r.added);
    return 0;
  }
  if (flag('help') || !command.length) { console.log(CAGE_HELP); return command.length ? 0 : 2; }

  const ok = cageAvailable();
  if (!ok.ok) { console.error(`agentcrash cage: ${ok.why}`); return 2; }

  const [cmd, ...args] = command;
  const profile = many('profile')[0] || (PROFILES[path.basename(cmd)] ? path.basename(cmd) : null);
  if (!profile) console.error(`agentcrash cage: no profile for "${path.basename(cmd)}": nothing of its state is kept and no model host is allowed (--profile, --rw, --allow)`);
  const net = flag('open-net') ? 'open' : 'gate';
  const local = many('local');
  const allow = [...(PROFILES[profile]?.hosts || []), ...(flag('registries') ? REGISTRIES : []), ...many('allow'), ...local.map((p) => `127.0.0.1:${p}`)];
  const gate = await startGate({ allow });
  let c;
  try {
    c = cage({
      cmd, args, home: os.homedir(), ws: process.cwd(), env: process.env, gateDir: gate.dir, profile,
      opts: { net, local, tty: !!process.stdin.isTTY, rw: many('rw'), ro: many('ro'), env: many('env'), gitWrite: flag('git-write'), showEnv: flag('show-env') },
    });
  } catch (e) { await gate.close(); console.error(`agentcrash cage: ${e.message}`); return 2; }
  if (c.missing) { await gate.close(); console.error(`agentcrash cage: ${c.missing} is not on your PATH`); return 127; }
  if (flag('print')) { await gate.close(); console.log([c.cmd, ...c.args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`)).join(' ')); return 0; }

  const quiet = flag('quiet');
  const snap = flag('no-snapshot') ? null : snapshot(process.cwd());
  if (!quiet) {
    console.error(`agentcrash cage: ${profile || path.basename(cmd)} in ${process.cwd()}`);
    console.error(`  network: ${net === 'open' ? 'open (--open-net)' : allow.length ? allow.join(', ') : 'nothing allowed'}`);
    if (c.hidden.length) console.error(`  .env read as empty: ${c.hidden.map((f) => path.relative(process.cwd(), f)).join(', ')}`);
    console.error(`  environment: ${c.dropped.length} of your variables left outside`);
    // What the repository itself is about to start in this agent.
    const mine = inspectDir(process.cwd()).findings.filter((f) => runs(f) && (f.when === 'open' || f.when === 'trusted') && (!profile || f.agent === profile)).map((f) => ({ ...f, command: f.command ?? f.file }));
    if (mine.length) console.error(`  this repository starts ${mine.length} command(s) in the agent, inside the cage: ${mine.slice(0, 3).map((f) => f.command.length > 60 ? f.command.slice(0, 60) + '…' : f.command).join(' · ')}${mine.length > 3 ? ' · …' : ''} (agentcrash inspect)`);
    if (snap) console.error(snap.error ? `  undo: not available (${snap.error})` : `  undo: ${snap.files} file(s) recorded; agentcrash cage --undo puts them back`);
  }
  const code = await new Promise((resolve) => {
    // Descriptor 3 carries the terminal filter when there is one.
    const filter = c.seccomp ? fs.openSync(c.seccomp, 'r') : null;
    const child = spawn(c.cmd, c.args, { env: c.env, stdio: ['inherit', 'inherit', 'inherit', ...(filter === null ? [] : [filter])] });
    if (filter !== null) fs.closeSync(filter);
    // On a terminal the signal already reaches the whole foreground group.
    for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { if (!c.seccomp || sig !== 'SIGINT') child.kill(sig); });
    child.on('error', (e) => { console.error(`agentcrash cage: ${e.message}`); resolve(126); });
    child.on('exit', (status, signal) => resolve(signal ? 130 : status ?? 1));
  });
  const refused = gate.log.filter((e) => !e.allowed);
  if (!quiet && refused.length) {
    console.error(`agentcrash cage: refused ${refused.reduce((n, e) => n + e.count, 0)} connection(s):`);
    for (const e of refused) console.error(`  ${e.host}:${e.port}${e.count > 1 ? ` ×${e.count}` : ''}`);
    console.error('  (--allow <host> lets one through next time)');
  }
  await gate.close();
  if (!quiet && snap && !snap.error) {
    const ch = changes(process.cwd());
    if (ch && ch.deleted.length + ch.changed.length + ch.added.length) {
      console.error(`agentcrash cage: this session deleted ${ch.deleted.length}, changed ${ch.changed.length}, added ${ch.added.length} file(s)`);
      list('deleted', ch.deleted);
      if (ch.deleted.length + ch.changed.length) console.error('  (agentcrash cage --undo puts them back)');
    }
  }
  return code;
}
