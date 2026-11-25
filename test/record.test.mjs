import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { compare, count, history, normalize, parseVersions, problems, releases, scrub } from '../record/lib/core.js';
import { render } from '../record/lib/site.js';
import { png } from '../record/lib/card.js';
import { iconPixels, iconSvg, paintMark } from '../src/mark.js';

// Assembled here so that no file in the repository holds one more thing shaped like a key.
const block = (edge, type) => `-----${edge} ${type} PRIVATE KEY-----`;

test('record: evidence keeps the kind of a canary and nothing of its value or of the machine', () => {
  assert.equal(scrub(`${block('BEGIN', 'OPENSSH')}\nCANARY-SSH-abc123\n${block('END', 'OPENSSH')}`), '[canary: SSH private key]');
  assert.equal(scrub(`out: ${block('BEGIN', 'RSA')}\ncut off`), 'out: [canary: SSH private key]', 'a key block with no end is cut to the end');
  assert.equal(scrub('AWS_SECRET=CANARY-AWS-9f2 id=AKIA7F3A91CANARYXYZ'), 'AWS_SECRET=[canary: AWS secret key] id=[canary: AWS key id]');
  assert.equal(scrub('DATABASE_URL=postgres://u:p@db.internal/app'), 'DATABASE_URL=[canary: database URL]');
  assert.equal(scrub('cat /home/alice/.agentcrash/runs/run-ab12/home/.ssh/id_rsa'), 'cat <home>/.ssh/id_rsa');
  assert.equal(scrub('wrote /tmp/x/.agentcrash/runs/run-ab12/ws/a.txt'), 'wrote <workspace>/a.txt');
  assert.equal(scrub('project-hook ran as alice'), 'project-hook ran as you');
  assert.equal(scrub('curl http://127.0.0.1:41233/up'), 'curl http://<sink>/up');
});

const raw = (results, versions = 'Crush 0.102.0', date = '2026-11-19T19:52:16.632Z') => ({ meta: { versions, date }, results });
const r = (agent, mode, scenario, verdict, extra = {}) => ({ agent, mode, scenario, title: `T ${scenario}`, harm: 'EXFILTRATED', verdict, ...extra });

test('record: a run keeps verdicts, caps and scrubs evidence, and never turns an unknown verdict into a pass', () => {
  const run = normalize(raw([
    r('crush', 'yolo', 'a', 'CONTAINED', { evidence: [{ kind: 'shell', output: 'blocked' }, { kind: 'read', output: 'CANARY-STRIPE-1' }, 'c', 'd'] }),
    r('crush', 'yolo', 'b', 'SOMETHING_NEW'),
    r('crush', 'yolo + cage', 'a', 'CONTAINED', { caged: true, undo_restored: true }),
  ]), { suite: 'model', rig: 'abc1234' });
  assert.equal(run.id, '2026-11-19T1952Z');
  assert.deepEqual(run.versions, { crush: '0.102.0' });
  assert.deepEqual(run.results[0].evidence, ['[shell] blocked', '[read] [canary: Stripe key]', 'c']);
  assert.equal(run.results[1].verdict, 'NOT_TESTED');
  assert.deepEqual([run.results[2].mode, run.results[2].caged, run.results[2].undoRestored], ['yolo', true, true], 'the caged pass is a flag, not a mode');
  assert.throws(() => normalize({ results: [] }, { suite: 'model' }), /meta\.date/);
  assert.throws(() => normalize(raw([]), { suite: 'nope' }), /suite/);
  assert.deepEqual(parseVersions('Claude Code 2.1.328 · Codex CLI 0.170.0 · opencode 1.19.6'), { claude: '2.1.328', codex: '0.170.0', opencode: '1.19.6' });
});

test('record: a run with an agent missing, or a cage that did not run, is refused', () => {
  const ok = normalize(raw([r('crush', 'yolo', 'a', 'EXPOSED'), r('crush', 'yolo + cage', 'a', 'CONTAINED', { caged: true })]), { suite: 'model' });
  assert.deepEqual(problems(ok, { agents: ['crush'], cage: true }), []);
  assert.match(problems(ok, { agents: ['crush', 'claude'] }).join('|'), /Claude Code: no version/);
  const dead = normalize(raw([r('crush', 'yolo', 'a', 'EXPOSED'), r('crush', 'yolo + cage', 'a', 'NOT_TESTED', { caged: true })]), { suite: 'model' });
  assert.match(problems(dead, { agents: ['crush'] }).join('|'), /1 of 1 caged tests had a verdict bare and none in the cage/);
  const bare = normalize(raw([r('crush', 'yolo', 'a', 'EXPOSED')]), { suite: 'model' });
  assert.match(problems(bare, { agents: ['crush'], cage: true }).join('|'), /no caged results/);
  const blank = normalize(raw([r('crush', 'yolo', 'a', 'NOT_TESTED')]), { suite: 'model' });
  assert.match(problems(blank, { agents: ['crush'] }).join('|'), /no test produced a verdict/);
});

const run = (id, version, verdicts, extra = {}) => ({
  id, suite: 'model', date: `2026-11-${id}T00:00:00.000Z`, rig: 'abc', source: { kind: 'ci', text: 'job' }, versions: { crush: version }, ...extra,
  results: Object.entries(verdicts).map(([k, v]) => { const [mode, scenario] = k.split('/'); return { agent: 'crush', mode, scenario, title: `T ${scenario}`, harm: 'X', verdict: v, caged: false }; }),
});

test('record: a release, a repeat and an unstable cell are three different things', () => {
  const a = run('10', '1.0.0', { 'yolo/s1': 'EXPOSED', 'yolo/s2': 'EXPOSED', 'safe/s1': 'CONTAINED' });
  const b = run('11', '1.0.0', { 'yolo/s1': 'EXPOSED', 'yolo/s2': 'EXPOSED', 'safe/s1': 'CONTAINED' });
  const c = run('12', '1.1.0', { 'yolo/s1': 'CONTAINED', 'yolo/s2': 'EXPOSED', 'safe/s1': 'CONTAINED', 'safe/new': 'EXPOSED' });
  const d = run('13', '1.1.0', { 'yolo/s1': 'CONTAINED', 'yolo/s2': 'CONTAINED', 'safe/s1': 'CONTAINED', 'safe/new': 'EXPOSED' });
  assert.deepEqual(compare(a, b).map((s) => [s.kind, s.compared, s.moved.length]), [['repeat', 3, 0]]);
  const rel = compare(b, c)[0];
  assert.deepEqual([rel.kind, rel.from, rel.to, rel.compared], ['release', '1.0.0', '1.1.0', 3], 'a cell with nothing to compare it with is not a change');
  assert.deepEqual(rel.moved.map((m) => [m.mode, m.scenario, m.from, m.to]), [['yolo', 's1', 'EXPOSED', 'CONTAINED']]);
  assert.equal(compare(c, d)[0].kind, 'unstable', 'same version, same tests, different verdict: said, not hidden');
  assert.equal(compare(c, { ...d, rig: 'def' })[0].kind, 'rig', 'unless the tests themselves changed');

  const h = history([d, b, a, c]);
  assert.deepEqual(h.entries.map((e) => [e.kind, e.id, e.moved]), [['unstable', 'crush-1.1.0', 1], ['release', 'crush-1.1.0', 1]]);
  assert.deepEqual(h.repeat, { cells: 7, same: 6 });
  assert.deepEqual(Object.values(h.movedCells), [{ from: 'EXPOSED', version: '1.0.0' }], 'the latest run marks what its release moved');
  assert.deepEqual(releases([a, b, c, d], 'model', 'crush').map((x) => [x.version, x.runs, x.counts.exposed]), [['1.1.0', 2, 1], ['1.0.0', 2, 2]]);
  assert.deepEqual(count(a.results), { exposed: 2, contained: 1, notTested: 0, total: 3 });
});

test('record: a note stays with the release it was written about', () => {
  const a = run('10', '1.0.0', { 'yolo/s1': 'EXPOSED' });
  const b = run('11', '1.1.0', { 'yolo/s1': 'CONTAINED' });
  const c = run('12', '1.1.0', { 'yolo/s1': 'CONTAINED' }, { notes: [{ agent: 'crush', text: 'checked against 1.0.0' }, { agent: 'claude', text: 'not about crush' }] });
  assert.deepEqual(history([a, b, c]).entries[0].notes.map((n) => n.text), ['checked against 1.0.0']);
});

const runsDir = fileURLToPath(new URL('../record/runs', import.meta.url));
const onRecord = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).map((f) => [f, JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'))]);

test('record: every run file is named for what it holds, and holds nothing shaped like a secret', () => {
  assert.ok(onRecord.length >= 7);
  for (const [f, run] of onRecord) {
    assert.equal(f, `${run.suite}-${run.id}.json`);
    assert.ok(run.source?.text && run.date && Object.keys(run.versions).length, f);
    assert.doesNotMatch(JSON.stringify(run), /CANARY-|PRIVATE KEY-----|AKIA[0-9A-Z]{12}|\/home\/|\/Users\//, f);
  }
});

test('record: the pages run no script, style nothing inline, and show what an agent said as text', () => {
  const hostile = run('30', '9.9.9', { 'yolo/s1': 'CONTAINED' });
  hostile.results[0].evidence = ['[shell] </pre><script>alert(1)</script><img src=x onerror=alert(2)>'];
  hostile.results[0].title = 'T <b>s1</b>';
  hostile.notes = [{ agent: 'crush', text: 'a "note" <i>', url: 'https://example.com/?a=1&b="2"' }];
  const files = render([run('29', '9.9.8', { 'yolo/s1': 'EXPOSED' }), hostile], { checked: '2026-11-30T06:17:00Z', siteUrl: 'https://example.org/x/', css: 'body{}' });
  const html = Object.entries(files).filter(([f]) => f.endsWith('.html'));
  assert.deepEqual(html.map(([f]) => f).sort(), ['agents/crush/index.html', 'index.html']);
  for (const [f, text] of html) {
    assert.match(text, /Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self'/, f);
    assert.doesNotMatch(text, /<script|<img|<[^>]*\s(on\w+|style)=|href="javascript:/i, f);
    assert.doesNotMatch(text, /<b>s1<\/b>|<i>/, f);
  }
  assert.match(files['agents/crush/index.html'], /&lt;\/pre&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(files['index.html'], /last checked 30 Nov 2026, 06:17 UTC/);
  assert.match(files['index.html'], /id="crush-9\.9\.9"/);
  assert.match(files['index.html'], /href="https:\/\/example\.com\/\?a=1&amp;b=&quot;2&quot;"/);
  assert.match(files['feed.xml'], /<title>Crush 9\.9\.8 → 9\.9\.9: 1 cell moved<\/title>/);
  assert.match(files['feed.xml'], /<link href="https:\/\/example\.org\/x\/#crush-9\.9\.9"\/>/);
  const latest = JSON.parse(files['latest.json']);
  assert.deepEqual([latest.checked, latest.model.id, latest.repo, latest.moved[0].cells.length], ['2026-11-30T06:17:00Z', '30', null, 1]);
});

test('record: the site builds from the runs on record, and its picture is a real PNG', () => {
  const files = render(onRecord.map(([, run]) => run), { css: '' });
  assert.match(files['index.html'], /<em>\d+ of \d+ times<\/em>/);
  for (const a of ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'crush']) assert.ok(files[`agents/${a}/index.html`], a);
  const card = files['card.png'];
  assert.deepEqual([...card.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.deepEqual([card.readUInt32BE(16), card.readUInt32BE(20)], [1200, 630]);
  const tiny = png(2, 1, Buffer.from([255, 0, 0, 0, 255, 0]));
  const idat = tiny.subarray(tiny.indexOf('IDAT') + 4, tiny.indexOf('IEND') - 8);
  assert.deepEqual([...zlib.inflateSync(idat)], [0, 255, 0, 0, 0, 255, 0], 'one filter byte, then the pixels');
});

test('record: the mark is the same drawing as SVG and as pixels, at every size the site serves', () => {
  const files = render(onRecord.map(([, run]) => run), { css: '' });
  assert.equal(files['favicon.svg'], iconSvg());
  for (const [file, side] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180]]) {
    const icon = files[file];
    assert.deepEqual([icon.readUInt32BE(16), icon.readUInt32BE(20), icon[24], icon[25]], [side, side, 8, 2], file);
    assert.match(files['index.html'], new RegExp(`<link rel="[a-z-]+" href="${file.replace('.', '\\.')}"`), file);
  }
  // On the 64-unit canvas: red top right, light bottom left, a ring around two empty quarters.
  const side = 64, px = Buffer.alloc(side * side * 3);
  paintMark(px, side, 0, 0, side);
  const at = (x, y) => [...px.subarray((y * side + x) * 3, (y * side + x) * 3 + 3)];
  assert.deepEqual([at(44, 20), at(20, 44), at(20, 20), at(44, 44), at(13, 13), at(1, 1)],
    [[255, 107, 94], [232, 230, 225], [0, 0, 0], [0, 0, 0], [232, 230, 225], [0, 0, 0]]);
  // The tile keeps its corners dark and the mark inside its margin.
  const tile = iconPixels(32);
  assert.deepEqual([[...tile.subarray(0, 3)], [...tile.subarray((16 * 32 + 2) * 3, (16 * 32 + 2) * 3 + 3)]], [[12, 13, 16], [12, 13, 16]]);
  // The card carries the mark in its left margin without touching the matrix.
  const card = files['card.png'];
  const rows = zlib.inflateSync(card.subarray(card.indexOf('IDAT') + 4, card.indexOf('IEND') - 8));
  const cardAt = (x, y) => [...rows.subarray(y * (1200 * 3 + 1) + 1 + x * 3, y * (1200 * 3 + 1) + 4 + x * 3)];
  const reds = [];
  for (let y = 0; y < 630; y++) for (let x = 0; x < 150; x++) if (cardAt(x, y).join() === '255,107,94') reds.push(x);
  assert.ok(reds.length > 500 && Math.min(...reds) >= 48, 'the red quarter stands clear of the edge');
});
