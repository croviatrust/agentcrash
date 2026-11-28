// The same reading, of a public GitHub repository that is not on this machine:
// the config files are fetched as text and handed to inspectFiles. Nothing is
// cloned and nothing is executed. No imports beyond inspect-core, so the same
// file runs in Node and in the browser page (site/index.html).
//
// Requests go to two fixed hosts and nowhere else, whatever the repository says:
//   api.github.com             one call, for the commit and the file list
//   raw.githubusercontent.com  one call per config file that exists
import { PROJECT_FILES, CODE_DIRS, isCode, inspectFiles } from './inspect-core.js';

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const REPO = /^[A-Za-z0-9._-]{1,100}$/;
const MAX = 1024 * 1024;

// "owner/repo", "github:owner/repo", or a github.com URL. Returns null for anything else.
export function parseSpec(spec) {
  let s = String(spec ?? '').trim();
  s = s.replace(/^github:/i, '').replace(/^(?:https?:\/\/)?(?:www\.)?github\.com\//i, '').replace(/^git@github\.com:/i, '');
  s = s.replace(/[?#].*$/, '').replace(/\/+$/, '');
  const [owner, repo, ...rest] = s.split('/');
  if (!owner || !repo) return null;
  if (rest.length && !['tree', 'blob', 'pull', 'issues', 'commits', 'actions'].includes(rest[0])) return null;
  const name = repo.replace(/\.git$/i, '');
  if (!OWNER.test(owner) || !REPO.test(name) || name === '.' || name === '..') return null;
  return { owner, repo: name };
}

export class RemoteError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function get(fetchFn, url, accept) {
  let r;
  try {
    r = await fetchFn(url, { headers: accept ? { Accept: accept } : {}, redirect: 'follow' });
  } catch {
    throw new RemoteError('network', 'GitHub could not be reached.');
  }
  return r;
}

// Returns { owner, repo, sha, findings, unreadable, read, listed }.
//   read:   the config files that were there
//   listed: false when the file list could not be had (rate limit, huge tree):
//           files loaded as code from .opencode/ are then not in the answer
export async function inspectGitHub(spec, fetchFn = globalThis.fetch) {
  const id = typeof spec === 'string' ? parseSpec(spec) : spec;
  if (!id) throw new RemoteError('spec', 'That is not a GitHub repository: use owner/repo.');
  const { owner, repo } = id;
  const api = `https://api.github.com/repos/${owner}/${repo}`;
  const raw = (ref, p) => `https://raw.githubusercontent.com/${owner}/${repo}/${ref}/${p.split('/').map(encodeURIComponent).join('/')}`;

  let sha = null, tree = null, limited = false;
  const t = await get(fetchFn, `${api}/git/trees/HEAD?recursive=1`, 'application/vnd.github+json');
  if (t.status === 404) throw new RemoteError('missing', `${owner}/${repo} is not a public repository on GitHub.`);
  if (t.status === 409) return { owner, repo, sha: null, findings: [], unreadable: [], read: [], listed: true, empty: true };
  if (t.ok) {
    const j = await t.json();
    if (typeof j.sha === 'string' && /^[0-9a-f]{40,64}$/.test(j.sha)) sha = j.sha;
    if (Array.isArray(j.tree) && !j.truncated) tree = j.tree;
  } else if (t.status === 403 || t.status === 429) limited = true;
  else throw new RemoteError('github', `GitHub answered ${t.status}.`);

  const ref = sha || 'HEAD';
  const files = {}, code = [], read = [];
  const want = Object.keys(PROJECT_FILES);
  if (tree) {
    const at = new Map(tree.map((e) => [e.path, e]));
    for (const p of want) {
      const e = at.get(p);
      // 100644/100755 only: a symlink's text is a path, not a config.
      if (!e || e.type !== 'blob' || !/^100/.test(e.mode) || e.size >= MAX) continue;
      const r = await get(fetchFn, raw(ref, p));
      if (r.ok) { files[p] = await r.text(); read.push(p); }
    }
    for (const e of tree) {
      if (e.type !== 'blob' || !/^100/.test(e.mode)) continue;
      const dir = CODE_DIRS.find((d) => e.path.startsWith(`${d}/`) && !e.path.slice(d.length + 1).includes('/'));
      if (dir && isCode(e.path)) code.push(e.path);
    }
    code.sort();
  } else {
    // No list: ask for each known file by name.
    const got = await Promise.all(want.map(async (p) => {
      const r = await get(fetchFn, raw(ref, p));
      if (!r.ok) {
        if (r.status === 404) return null;
        throw new RemoteError('github', `GitHub answered ${r.status} for ${p}.`);
      }
      const text = await r.text();
      return text.length < MAX ? [p, text] : null;
    }));
    for (const g of got) if (g) { files[g[0]] = g[1]; read.push(g[0]); }
    if (!read.length && limited) {
      // Every file missing looks the same as a repository that is not there.
      const probe = await get(fetchFn, raw(ref, 'README.md'));
      if (probe.status === 404) {
        const again = await get(fetchFn, `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/.gitignore`);
        if (again.status === 404) throw new RemoteError('limited', 'GitHub is rate-limiting this address and the repository could not be confirmed. Try again in a few minutes.');
      }
    }
  }
  return { owner, repo, sha, ...inspectFiles(files, code), read, listed: !!tree };
}
