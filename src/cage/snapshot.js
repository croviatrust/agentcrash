// The cage leaves the workspace writable: an agent that cannot write code is
// no use. So before every session the workspace is recorded, outside the cage
// where the agent cannot reach it, and `agentcrash cage --undo` puts it back.
//
// The record is a git object store of its own (not your repository's): it
// includes uncommitted and untracked files, and leaves out what .gitignore
// leaves out.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const REF = 'refs/agentcrash/session';

export function snapshotDir(ws, root = path.join(os.homedir(), '.agentcrash', 'snapshots')) {
  return path.join(root, crypto.createHash('sha256').update(fs.realpathSync(ws)).digest('hex').slice(0, 16));
}

// git with nothing of yours in it: no global or system config, no hooks, no
// filters, so nothing a repository carries can run from here.
function git(dir, ws, args, { timeout = 120000 } = {}) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'gc.auto=0', '-c', 'commit.gpgsign=false',
    '-c', 'core.autocrlf=false', '-c', 'user.name=agentcrash', '-c', 'user.email=cage@agentcrash.invalid', '-c', 'advice.addEmbeddedRepo=false', ...args], {
    encoding: 'utf8', timeout, maxBuffer: 64 << 20,
    env: { PATH: process.env.PATH, GIT_DIR: dir, ...(ws ? { GIT_WORK_TREE: ws } : {}), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} failed`).trim().split('\n').pop());
  return r.stdout;
}

function commit(dir, ws, message) {
  git(dir, ws, ['add', '-A', '.']);
  git(dir, ws, ['commit', '-q', '--allow-empty', '--no-verify', '-m', message]);
  return git(dir, ws, ['rev-parse', 'HEAD']).trim();
}

// Record the workspace as it is now. Returns null when it cannot (no git).
export function snapshot(ws, dir = snapshotDir(ws)) {
  try {
    ws = fs.realpathSync(ws);
    if (!fs.existsSync(path.join(dir, 'HEAD'))) {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      git(dir, null, ['init', '-q', '--bare', dir]);
      git(dir, null, ['config', 'core.bare', 'false']);
    }
    const id = commit(dir, ws, `session ${new Date().toISOString()}`);
    git(dir, ws, ['update-ref', REF, id]);
    const files = git(dir, ws, ['ls-tree', '-r', '--name-only', '-z', id]).split('\0').filter(Boolean).length;
    return { id, files, dir };
  } catch (e) { return { error: e.message }; }
}

// What differs from the last recorded session: { deleted, changed, added }.
export function changes(ws, dir = snapshotDir(ws)) {
  ws = fs.realpathSync(ws);
  const out = { deleted: [], changed: [], added: [] };
  if (!fs.existsSync(path.join(dir, 'HEAD'))) return null;
  let id;
  try { id = git(dir, ws, ['rev-parse', '--verify', '-q', REF]).trim(); } catch { return null; }
  git(dir, ws, ['read-tree', id]);
  const z = git(dir, ws, ['diff', '--name-status', '--no-renames', '-z', id, '--', '.']).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < z.length; i += 2) (z[i] === 'D' ? out.deleted : out.changed).push(z[i + 1]);
  out.added = git(dir, ws, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  return { ...out, id };
}

// Put back every file the last session deleted or changed. What is there now
// is recorded first, so an undo can itself be looked at afterwards. Files the
// session added are left where they are, and listed.
export function undo(ws, dir = snapshotDir(ws)) {
  ws = fs.realpathSync(ws);
  const ch = changes(ws, dir);
  if (!ch) return null;
  const before = commit(dir, ws, `before undo ${new Date().toISOString()}`);
  if (ch.deleted.length || ch.changed.length) git(dir, ws, ['checkout', '-f', ch.id, '--', '.']);
  git(dir, ws, ['read-tree', ch.id]);
  return { ...ch, before };
}

// True when every recorded file is on disk again, byte for byte.
export function intact(ws, dir, id) {
  ws = fs.realpathSync(ws);
  git(dir, ws, ['read-tree', id]);
  return git(dir, ws, ['diff', '--name-only', id, '--', '.']).trim() === '';
}
