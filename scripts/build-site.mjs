#!/usr/bin/env node
// Assemble the static page: site/ plus the two source files it runs.
//   node scripts/build-site.mjs [out-dir]     (default: _site)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const out = path.resolve(process.argv[2] || path.join(root, '_site'));
fs.mkdirSync(out, { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'site'))) fs.copyFileSync(path.join(root, 'site', f), path.join(out, f));
for (const f of ['inspect-core.js', 'remote.js']) fs.copyFileSync(path.join(root, 'src', f), path.join(out, f));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`site written to ${out}`);
