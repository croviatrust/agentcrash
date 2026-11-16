import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';

const RUN = path.resolve('action/run.mjs');

// A repository with one clean commit and, on top of it, a change in the working tree.
function repo(change) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'action-'));
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
  git('init', '-q');
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { old: { command: 'node', args: ['old.js'] } } }));
  git('add', '.mcp.json');
  git('commit', '-qm', 'base');
  const base = git('rev-parse', 'HEAD');
  change(dir);
  return { dir, base };
}
function act(dir, env) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'action-out-'));
  const files = { GITHUB_STEP_SUMMARY: path.join(tmp, 'summary'), GITHUB_OUTPUT: path.join(tmp, 'output') };
  const r = spawnSync(process.execPath, [RUN], { encoding: 'utf8', env: { PATH: process.env.PATH, GITHUB_WORKSPACE: dir, ...files, ...env } });
  const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
  return { ...r, summary: read(files.GITHUB_STEP_SUMMARY), output: read(files.GITHUB_OUTPUT) };
}
const addServer = (dir) => fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { old: { command: 'node', args: ['old.js'] }, fresh: { command: 'npx', args: ['-y', 'thing'] } } }));

test('action: a change that adds a command fails, and only the addition is reported', () => {
  const { dir, base } = repo(addServer);
  const r = act(dir, { AC_EVENT: 'push', AC_BEFORE: base });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /^::error file=\.mcp\.json,title=agentcrash%3A added by this change::MCP server "fresh" starts: npx -y thing/m);
  assert.doesNotMatch(r.stdout, /"old"/);
  assert.equal(r.output, 'findings=1\nblocking=1\n');
  assert.match(r.summary, /\*\*1 thing\*\* added here acts/);
});

test('action: a change that adds nothing passes, whatever the repository already holds', () => {
  const { dir, base } = repo((d) => fs.writeFileSync(path.join(d, 'README.md'), 'hello'));
  const r = act(dir, { AC_EVENT: 'push', AC_BEFORE: base });
  assert.equal(r.status, 0);
  assert.equal(r.output, 'findings=0\nblocking=0\n');
  assert.match(r.summary, /adds no command/);
  // fail-on: any looks at the whole repository instead.
  assert.equal(act(dir, { AC_EVENT: 'push', AC_BEFORE: base, AC_FAIL_ON: 'any' }).status, 1);
});

test('action: fail-on never reports and passes; an unreadable base reports everything and passes', () => {
  const { dir, base } = repo(addServer);
  const never = act(dir, { AC_EVENT: 'push', AC_BEFORE: base, AC_FAIL_ON: 'never' });
  assert.equal(never.status, 0);
  assert.match(never.stdout, /^::warning file=\.mcp\.json/m);
  const lost = act(dir, { AC_EVENT: 'push', AC_BEFORE: '1'.repeat(40) });
  assert.equal(lost.status, 0);
  assert.match(lost.stdout, /could not be read/);
  assert.equal(lost.output, 'findings=2\nblocking=2\n');
  // A brand-new branch pushes with an all-zero "before": nothing to compare against.
  assert.equal(act(dir, { AC_EVENT: 'push', AC_BEFORE: '0'.repeat(40) }).status, 0);
});

test('action: on a pull request the base is the first parent of the merge commit that was checked out', () => {
  const { dir, base } = repo(() => {});
  const git = (...a) => execFileSync('git', a, { cwd: dir, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } }).trim();
  const main = git('rev-parse', '--abbrev-ref', 'HEAD');
  git('checkout', '-qb', 'pr');
  addServer(dir); git('add', '.mcp.json'); git('commit', '-qm', 'pr');
  git('checkout', '-q', main);
  // The base moves on after the pull request was opened, adding a server of its own.
  fs.mkdirSync(path.join(dir, '.codex'));
  fs.writeFileSync(path.join(dir, '.codex/config.toml'), '[mcp_servers.frombase]\ncommand = "bash"\n');
  git('add', '.codex/config.toml'); git('commit', '-qm', 'base moves');
  git('merge', '-q', '--no-ff', '-m', 'merge', 'pr');
  const r = act(dir, { AC_EVENT: 'pull_request', AC_PR_BASE: base });
  assert.equal(r.status, 1);
  assert.match(r.stdout, /"fresh"/);
  assert.doesNotMatch(r.stdout, /frombase/, 'what the base branch added is not the pull request\'s doing');
  assert.equal(r.output, 'findings=1\nblocking=1\n');
});

test('action: text from the repository cannot issue workflow commands or break out of the summary', () => {
  const { dir, base } = repo((d) => fs.writeFileSync(path.join(d, '.mcp.json'), JSON.stringify({ mcpServers: {
    'x\n::set-output name=a::b': { command: 'bash', args: ['-c', 'echo </pre><script>alert(1)</script>\r\n::error::fake'] },
  } })));
  const r = act(dir, { AC_EVENT: 'push', AC_BEFORE: base });
  assert.equal(r.status, 1);
  for (const line of r.stdout.split('\n')) if (line.startsWith('::')) assert.match(line, /^::(error|notice|warning) file=\.mcp\.json,/);
  assert.doesNotMatch(r.stdout, /^::set-output/m);
  assert.doesNotMatch(r.stdout, /^::error::fake/m);
  assert.doesNotMatch(r.summary, /<script>|<\/pre><script/);
  assert.match(r.summary, /&lt;script&gt;/);
});
