#!/usr/bin/env node
// Assemble the static site.
//   /            the record: every run of the crash test, and what moved (record/)
//   /inspect/    the page that reads a repository in your browser (site/ plus the two source files it runs)
//
//   node scripts/build-site.mjs [out-dir]     (default: _site)
//
// RECORD_CHECKED_AT   when the installed agents were last compared with the record (set by the record workflow)
// RECORD_PREVIOUS     a latest.json from the site as it is published now, to carry that time over a rebuild
// SITE_URL            where the site is served, for the feed and the link preview
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { render } from '../record/lib/site.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, '_site'));

const inspect = path.join(out, 'inspect');
fs.mkdirSync(inspect, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'site'))) fs.copyFileSync(path.join(root, 'site', f), path.join(inspect, f));
for (const f of ['inspect-core.js', 'remote.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(inspect, f));

const runsDir = path.join(root, 'record', 'runs');
const runs = fs.readdirSync(runsDir).filter((f) => f.endsWith('.json')).sort().map((f) => JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8')));
let checked = process.env.RECORD_CHECKED_AT || null;
if (!checked && process.env.RECORD_PREVIOUS) {
  try { checked = JSON.parse(fs.readFileSync(process.env.RECORD_PREVIOUS, 'utf8')).checked || null; } catch { /* first publish */ }
}
const files = render(runs, {
  checked,
  siteUrl: (process.env.SITE_URL || 'https://croviatrust.github.io/agentcrash/').replace(/\/?$/, '/'),
  css: fs.readFileSync(path.join(root, 'record', 'site.css'), 'utf8'),
});
for (const [rel, content] of Object.entries(files)) {
  fs.mkdirSync(path.dirname(path.join(out, rel)), { recursive: true });
  fs.writeFileSync(path.join(out, rel), content);
}
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`site written to ${out}: ${runs.length} runs, ${Object.keys(files).length} record files`);
