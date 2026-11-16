// The page: read a public repository's agent config in the browser. Every
// string that comes from the repository is put on the page as text, never as
// markup, and the only hosts this page may talk to are named in its CSP.
import { describe, summary, blocking } from './inspect-core.js';
import { parseSpec, inspectGitHub } from './remote.js';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
const SELF = `${location.origin}${location.pathname}`;
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

function copyLine(parent, label, value) {
  const line = el('div', 'line');
  line.append(el('code', null, value));
  const b = el('button', 'small', label);
  b.type = 'button';
  b.addEventListener('click', async () => { try { await navigator.clipboard.writeText(value); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; } });
  line.append(b);
  parent.append(line);
}

function show(r) {
  const out = $('out');
  out.replaceChildren();
  out.hidden = false;
  const id = `${r.owner}/${r.repo}`;
  const n = r.findings.filter((f) => blocking(f, false)).length;
  const later = r.findings.length - n;
  const head = r.empty ? `${id} is empty.`
    : n ? `${id} starts ${n} thing${n > 1 ? 's' : ''} in your agent the moment you open it.`
      : later ? `${id} starts nothing on open, but brings ${later} thing${later > 1 ? 's' : ''} that act${later > 1 ? '' : 's'} once you trust or approve the folder.`
        : `${id} starts nothing in your agent.`;
  out.append(el('p', `verdict ${n ? 'open' : later ? 'trusted' : 'clear'}`, head));
  const at = r.sha ? `Read at commit ${r.sha.slice(0, 7)}` : 'Read at the default branch';
  out.append(el('p', 'quiet', `${at}: ${r.read.length} config file${r.read.length === 1 ? '' : 's'} for the six agents. Nothing was cloned or executed.${r.listed ? '' : ' GitHub would not list the files (rate limit, or a very large repository), so files loaded as code from .opencode/ are not in this answer.'}`));

  for (const file of [...new Set(r.findings.map((f) => f.file))]) {
    const box = el('div', 'file'), h = el('h3');
    const a = el('a', null, file);
    a.href = `https://github.com/${id}/blob/${r.sha || 'HEAD'}/${file.split('/').map(encodeURIComponent).join('/')}`;
    a.rel = 'noopener noreferrer nofollow';
    h.append(a); box.append(h);
    for (const f of r.findings.filter((x) => x.file === file)) {
      const d = describe(f), row = el('div', 'row');
      row.append(el('span', `tag ${d.level}`, d.tag));
      const text = el('span', 'text', clip(d.text, 400));
      for (const note of d.notes) text.append(el('span', 'note', `↳ ${clip(note, 300)}`));
      row.append(text); box.append(row);
    }
    out.append(box);
  }
  for (const file of r.unreadable) {
    const box = el('div', 'file');
    box.append(el('h3', null, file));
    const row = el('div', 'row');
    row.append(el('span', 'tag unmeasured', 'NOT PARSED'), el('span', 'text', 'could not be parsed; the agent may still read it'));
    box.append(row); out.append(box);
  }
  const lines = summary(r.findings);
  if (lines.length) {
    const ul = el('ul', 'sum');
    for (const l of lines) ul.append(el('li', l.level === 'plain' ? null : l.level, l.text));
    out.append(ul);
  }

  const share = el('div', 'share');
  const link = `${SELF}?r=${id}`;
  const label = n ? `${n} run${n > 1 ? '' : 's'} on open` : 'nothing runs on open';
  share.append(el('p', null, 'This result has a link, and a badge for the repository\'s README that points back to it:'));
  copyLine(share, 'Copy link', link);
  copyLine(share, 'Copy badge', `[![agentcrash: ${label}](https://img.shields.io/badge/agentcrash-${encodeURIComponent(label)}-${n ? 'red' : 'brightgreen'})](${link})`);
  share.append(el('p', 'quiet', 'The link reads the repository again each time it is opened; the badge says what was true when it was made.'));
  out.append(share);
}

async function run(spec, push) {
  const out = $('out'), go = $('go');
  const id = parseSpec(spec);
  out.hidden = false;
  if (!id) { out.replaceChildren(el('p', 'verdict', 'That is not a GitHub repository. Use owner/repo, or paste a github.com link.')); return; }
  $('q').value = `${id.owner}/${id.repo}`;
  if (push) history.pushState(null, '', `?r=${id.owner}/${id.repo}`);
  document.title = `${id.owner}/${id.repo} — agentcrash`;
  go.disabled = true;
  out.replaceChildren(el('p', 'quiet', `Reading ${id.owner}/${id.repo} from GitHub…`));
  try {
    show(await inspectGitHub(id, (url, init) => fetch(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' })));
  } catch (e) {
    out.replaceChildren(el('p', 'verdict', e && e.code ? e.message : 'GitHub could not be read. Try again.'));
  } finally {
    go.disabled = false;
  }
}

$('f').addEventListener('submit', (ev) => { ev.preventDefault(); run($('q').value, true); });
const fromUrl = () => { const r = new URLSearchParams(location.search).get('r'); if (r) run(r, false); };
window.addEventListener('popstate', fromUrl);
fromUrl();
