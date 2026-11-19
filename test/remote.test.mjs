import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { parseSpec, inspectGitHub } from '../src/remote.js';
import { inspectDir } from '../src/inspect.js';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const MCP = JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'some-pkg'] } } });
const res = (status, body = '') => ({ status, ok: status >= 200 && status < 300, json: async () => JSON.parse(body), text: async () => body });

// A stand-in for GitHub: { tree: status | object, files: { path: text } }. Records every URL asked for.
function github({ tree, files = {} }) {
  const asked = [];
  const fetchFn = async (url) => {
    asked.push(url);
    const u = new URL(url);
    if (u.hostname === 'api.github.com') return typeof tree === 'number' ? res(tree) : res(200, JSON.stringify(tree));
    assert.equal(u.hostname, 'raw.githubusercontent.com');
    const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
    return p in files ? res(200, files[p]) : res(404);
  };
  return { fetchFn, asked };
}
const blob = (p, size = 10, mode = '100644') => ({ path: p, type: 'blob', mode, size });
const SHA = 'c'.repeat(40);

test('parseSpec takes owner/repo and github.com links, and nothing else', () => {
  for (const s of ['a/b', 'github:a/b', 'https://github.com/a/b', 'http://www.github.com/a/b/', 'github.com/a/b.git', 'git@github.com:a/b.git', 'https://github.com/a/b/tree/main/src', 'https://github.com/a/b?tab=readme#x', '  a/b  ']) {
    assert.deepEqual(parseSpec(s), { owner: 'a', repo: 'b' }, s);
  }
  assert.deepEqual(parseSpec('Some-Org/my.repo_name-2'), { owner: 'Some-Org', repo: 'my.repo_name-2' });
  for (const s of ['', 'a', 'a/', '/b', '../etc', 'a/..', 'a/.', 'a/b/c', 'https://evil.example/a/b', 'https://github.com.evil.example/a/b', 'a/b c', 'a/b%2f..', '-a/b', 'a_b/c', `${'a'.repeat(40)}/b`, 'a/b@evil', 'javascript:alert(1)/x', null, undefined, 42]) {
    assert.equal(parseSpec(s), null, String(s));
  }
});

test('with a file list: reads the files that are there, at the commit, from two hosts only', async () => {
  const g = github({ tree: { sha: SHA, truncated: false, tree: [blob('.mcp.json'), blob('README.md'), blob('.opencode/plugin/x.ts'), blob('.opencode/plugin/deep/y.ts'), blob('.opencode/plugin/notes.md'), blob('src/.mcp.json')] }, files: { '.mcp.json': MCP } });
  const r = await inspectGitHub('a/b', g.fetchFn);
  assert.equal(r.sha, SHA);
  assert.equal(r.listed, true);
  assert.deepEqual(r.read, ['.mcp.json']);
  assert.deepEqual(r.findings.map((f) => [f.file, f.kind, f.when]), [['.opencode/plugin/x.ts', 'code', 'open'], ['.mcp.json', 'mcp', 'open']]);
  assert.deepEqual(g.asked, ['https://api.github.com/repos/a/b/git/trees/HEAD?recursive=1', `https://raw.githubusercontent.com/a/b/${SHA}/.mcp.json`]);
});

test('says the same as inspect on a clone of the same files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-remote-'));
  const files = {
    '.mcp.json': MCP,
    '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: './x.sh' }] }] }, permissions: { allow: ['Bash(*)'] } }),
    '.codex/config.toml': '[mcp_servers.a]\ncommand = "node"\nargs = ["s.js"]\n',
    'opencode.json': JSON.stringify({ mcp: { a: { type: 'local', command: ['node', 's.js'] } } }),
    '.opencode/plugin/p.js': 'export default {}',
  };
  for (const [p, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, p)), { recursive: true }); fs.writeFileSync(path.join(dir, p), t); }
  const g = github({ tree: { sha: SHA, truncated: false, tree: Object.keys(files).map((p) => blob(p)) }, files });
  const remote = await inspectGitHub('a/b', g.fetchFn), local = inspectDir(dir);
  assert.ok(local.findings.length >= 5);
  assert.deepEqual(remote.findings, local.findings);
});

test('a symlink, an oversized file and a truncated list are not read as config', async () => {
  const g = github({ tree: { sha: SHA, truncated: false, tree: [blob('.mcp.json', 10, '120000'), blob('crush.json', 2 * 1024 * 1024), { path: '.claude/settings.json', type: 'tree', mode: '040000' }] }, files: { '.mcp.json': MCP, 'crush.json': MCP } });
  const r = await inspectGitHub('a/b', g.fetchFn);
  assert.deepEqual(r.read, []);
  assert.equal(g.asked.length, 1);
  const t = github({ tree: { sha: SHA, truncated: true, tree: [] }, files: { '.mcp.json': MCP } });
  const rt = await inspectGitHub('a/b', t.fetchFn);
  assert.equal(rt.listed, false);
  assert.deepEqual(rt.read, ['.mcp.json']);
  assert.ok(t.asked.every((u) => u.startsWith(`https://raw.githubusercontent.com/a/b/${SHA}/`) || u.startsWith('https://api.github.com/repos/a/b/')));
});

test('rate-limited: falls back to asking for each known file, and says the list is missing', async () => {
  const g = github({ tree: 403, files: { '.mcp.json': MCP, 'README.md': '# x' } });
  const r = await inspectGitHub('a/b', g.fetchFn);
  assert.equal(r.listed, false);
  assert.equal(r.sha, null);
  assert.deepEqual(r.read, ['.mcp.json']);
  assert.equal(r.findings.length, 1);
  assert.ok(g.asked.slice(1).every((u) => u.startsWith('https://raw.githubusercontent.com/a/b/HEAD/')));
  await assert.rejects(inspectGitHub('a/b', github({ tree: 429 }).fetchFn), (e) => e.code === 'limited');
});

test('errors are named: not a repository, not there, unreachable, empty', async () => {
  await assert.rejects(inspectGitHub('../x', github({ tree: 200 }).fetchFn), (e) => e.code === 'spec');
  await assert.rejects(inspectGitHub('a/b', github({ tree: 404 }).fetchFn), (e) => e.code === 'missing');
  await assert.rejects(inspectGitHub('a/b', github({ tree: 500 }).fetchFn), (e) => e.code === 'github');
  await assert.rejects(inspectGitHub('a/b', async () => { throw new Error('offline'); }), (e) => e.code === 'network');
  const r = await inspectGitHub('a/b', github({ tree: 409 }).fetchFn);
  assert.equal(r.empty, true);
  assert.deepEqual(r.findings, []);
});

test('the page and the modules it loads use nothing from Node, and name only GitHub hosts', () => {
  for (const f of ['src/inspect-core.js', 'src/remote.js', 'site/app.js']) {
    const text = fs.readFileSync(path.join(REPO, f), 'utf8');
    assert.ok(!/from 'node:|require\(|process\.|Buffer\b/.test(text), f);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(text), f);
  }
  const html = fs.readFileSync(path.join(REPO, 'site/index.html'), 'utf8');
  assert.match(html, /connect-src https:\/\/api\.github\.com https:\/\/raw\.githubusercontent\.com;/);
  assert.match(html, /default-src 'none'; script-src 'self';/);
  assert.ok(!/<script(?![^>]*src=)/.test(html), 'no inline script');
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-site-'));
  const b = spawnSync(process.execPath, [path.join(REPO, 'scripts/build-site.mjs'), out], { encoding: 'utf8' });
  assert.equal(b.status, 0, b.stderr);
  // The page lives under /inspect/, with exactly the files it runs; the record is the front page.
  assert.deepEqual(fs.readdirSync(path.join(out, 'inspect')).sort(), ['app.js', 'index.html', 'inspect-core.js', 'remote.js', 'style.css']);
  assert.deepEqual(fs.readdirSync(out).sort(), ['.nojekyll', 'agents', 'card.png', 'favicon.svg', 'feed.xml', 'index.html', 'inspect', 'latest.json', 'record.css']);
});

test('CLI: something that is neither a folder nor owner/repo is refused before any request', () => {
  const BIN = path.join(REPO, 'bin/agentcrash.js');
  for (const bad of ['/nonexistent/dir/x', 'https://evil.example/a/b', 'a/b/c/d']) {
    const r = spawnSync(process.execPath, [BIN, 'inspect', bad], { encoding: 'utf8', env: { PATH: process.env.PATH, HTTPS_PROXY: 'http://127.0.0.1:9', HTTP_PROXY: 'http://127.0.0.1:9' } });
    assert.equal(r.status, 2, bad);
    assert.match(r.stderr, /not a directory, and not a GitHub repository/);
  }
  const r = spawnSync(process.execPath, [BIN, 'inspect', 'a/b', '--since', 'HEAD'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /--since needs a local clone/);
});
