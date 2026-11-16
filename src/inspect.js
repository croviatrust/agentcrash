// Reading a repository's agent config from disk or from a git ref, and
// printing it. What the config means is in inspect-core.js.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PROJECT_FILES, CODE_DIRS, isCode, inspectFiles, describe, summary } from './inspect-core.js';

export * from './inspect-core.js';

export function inspectDir(dir) {
  const files = {};
  for (const rel of Object.keys(PROJECT_FILES)) {
    const p = path.join(dir, rel);
    try {
      const st = fs.lstatSync(p);
      // A symlink could point anywhere on this machine; a config that size is not a config.
      if (st.isFile() && st.size < 1024 * 1024) files[rel] = fs.readFileSync(p, 'utf8');
    } catch { /* not there */ }
  }
  const code = [];
  for (const rel of CODE_DIRS) {
    try {
      if (!fs.lstatSync(path.join(dir, rel)).isDirectory()) continue;
      for (const name of fs.readdirSync(path.join(dir, rel)).sort()) if (isCode(name)) code.push(`${rel}/${name}`);
    } catch { /* not there */ }
  }
  return { dir, ...inspectFiles(files, code) };
}

// The same reading, of the files as they were at a git ref. Blobs are read
// straight from the object store: no checkout, no filter, no hook.
export function inspectRef(dir, ref) {
  const git = (args) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0' } });
  const commit = git(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]).trim();
  const files = {};
  for (const rel of Object.keys(PROJECT_FILES)) {
    try {
      // "100644 blob <sha>\t<path>": a regular file, not a symlink (120000) or a submodule.
      const [meta] = git(['ls-tree', commit, '--', `./${rel}`]).split('\t');
      const [mode, type, sha] = (meta || '').split(' ');
      if (type !== 'blob' || !/^100/.test(mode)) continue;
      if (Number(git(['cat-file', '-s', sha])) >= 1024 * 1024) continue;
      files[rel] = git(['cat-file', 'blob', sha]);
    } catch { /* not there at that ref */ }
  }
  const code = [];
  for (const rel of CODE_DIRS) {
    try {
      for (const entry of git(['ls-tree', commit, '--', `./${rel}/`]).split('\n')) {
        const [meta, p] = entry.split('\t');
        if (p && /^1[02]/.test(meta) && isCode(p)) code.push(`${rel}/${path.posix.basename(p)}`);
      }
    } catch { /* not there at that ref */ }
  }
  return { dir, ref, ...inspectFiles(files, code) };
}

// A repository chooses these strings; none of them gets to drive the terminal.
const plain = (s) => String(s).replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);

export function renderInspect({ dir, findings, unreadable, since }, { color = true } = {}) {
  const c = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
  const out = [`${c(1, 'agentcrash inspect')} — what ${plain(dir)} ${since ? `does to an agent opened in it that it did not at ${plain(since)}` : 'does to an agent opened in it'} (nothing was executed)`, ''];
  if (!findings.length) out.push(since ? `  Nothing new since ${plain(since)}: no added command, no added permission.` : '  No project config that starts a command or widens permissions for the six agents agentcrash knows.');
  for (const file of [...new Set(findings.map((f) => f.file))]) {
    out.push(`  ${c(1, file)}`);
    for (const f of findings.filter((x) => x.file === file)) {
      const d = describe(f), shown = plain(d.text);
      out.push(`    ${c(d.level === 'open' ? 31 : d.level === 'trusted' ? 33 : 2, d.tag.padEnd(19))} ${shown.length > 200 ? shown.slice(0, 200) + '…' : shown}`);
      for (const n of d.notes) out.push(`    ${' '.repeat(19)} ${c(2, `↳ ${plain(n)}`)}`);
    }
  }
  for (const f of unreadable) out.push(`  ${c(1, f)}\n    ${c(2, 'could not be parsed; the agent may still read it')}`);
  const lines = summary(findings);
  out.push('');
  for (const l of lines) out.push(l.level === 'open' ? c(31, l.text) : l.level === 'trusted' ? c(33, l.text) : l.text);
  if (lines.length) {
    out.push('', 'Measured on the versions named; interactive sessions of some of these CLIs ask first.', `Open it where there is nothing to take: ${c(1, 'agentcrash cage -- <agent>')}`);
  }
  return out.join('\n');
}
