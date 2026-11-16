#!/usr/bin/env node
// Census: how much project config on public GitHub starts a command in a
// coding agent the moment the repository is opened.
//
// It asks GitHub code search for the config files the agents read, takes a
// sample stratified by file size, reads each sampled file through the API and
// runs `agentcrash inspect` on the text. Nothing is cloned and nothing is
// executed. Only counts are written: no repository name, no file content, no
// credential ever reaches the output.
//
//   GITHUB_TOKEN=... node scripts/census.mjs [--per-stratum 40] [--out census/census.json]
import fs from 'node:fs';
import crypto from 'node:crypto';
import { inspectFiles, parseJsonc, runs } from '../src/inspect.js';

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d; };
const PER = Number(arg('per-stratum', 40));
const OUT = arg('out', 'census/census.json');
const TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
if (!TOKEN) { console.error('set GITHUB_TOKEN: GitHub code search needs an authenticated request'); process.exit(2); }

// file the agent reads at the repository root → the search that finds it
const KINDS = {
  '.mcp.json': 'filename:.mcp.json',
  '.claude/settings.json': 'filename:settings.json path:.claude',
  '.claude/settings.local.json': 'filename:settings.local.json path:.claude',
  '.codex/config.toml': 'filename:config.toml path:.codex',
  '.gemini/settings.json': 'filename:settings.json path:.gemini',
  '.qwen/settings.json': 'filename:settings.json path:.qwen',
  'opencode.json': 'filename:opencode.json',
  'opencode.jsonc': 'filename:opencode.jsonc',
  'crush.json': 'filename:crush.json',
};
const SIZES = ['0..149', '150..299', '300..599', '600..1199', '1200..2999', '>=3000'];

const DEBUG = arg('debug', '');
// The hook events agentcrash measured firing in a session that used no tool.
const MEASURED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'Stop']);
// Key names only, never a value: enough to see what the reader missed.
const shape = (text) => { try { const walk = (v, d) => (v && typeof v === 'object' && d < 5 ? (Array.isArray(v) ? v.slice(0, 2).map((x) => walk(x, d + 1)) : Object.fromEntries(Object.entries(v).slice(0, 12).map(([k, x]) => [k.slice(0, 30), walk(x, d + 1)]))) : typeof v); return walk(parseJsonc(text), 0); } catch { return text.split('\n').filter((l) => /^\s*\[|command/.test(l)).map((l) => l.replace(/=.*/, '=')).slice(0, 20); } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function gh(url, accept = 'application/vnd.github+json') {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: { authorization: `Bearer ${TOKEN}`, accept, 'user-agent': 'agentcrash-census', 'x-github-api-version': '2022-11-28' } });
    if (res.ok) return accept.includes('raw') ? res.text() : res.json();
    const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000 - Date.now();
    const limited = (res.status === 403 || res.status === 429) && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after'));
    if (limited && attempt < 8) { await sleep(Math.min(Math.max(reset, 0) + 1500, 70000) || Number(res.headers.get('retry-after')) * 1000 || 30000); continue; }
    if (res.status >= 500 && attempt < 3) { await sleep(3000); continue; }
    if (res.status === 404 || res.status === 403 || res.status === 451) return null;
    throw new Error(`${res.status} ${url.replace(/\?.*/, '')}`);
  }
}

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const strata = [];
for (const [file, q] of Object.entries(KINDS)) {
  for (const size of SIZES) {
    const res = await gh(`https://api.github.com/search/code?q=${encodeURIComponent(`${q} size:${size}`)}&per_page=100`);
    await sleep(6500); // code search allows ten requests a minute
    const items = res?.items ?? [];
    // The search matches look-alikes (.mcp.json.example) and copies in subfolders;
    // only the exact file at the repository root is what an agent opened there reads.
    const exact = items.filter((it) => it.path === file);
    const s = { file, size, indexed: res?.total_count ?? 0, returned: items.length, at_root: exact.length, sampled: 0, rows: [] };
    for (const it of exact.slice(0, PER)) {
      const text = await gh(it.url, 'application/vnd.github.raw');
      if (typeof text !== 'string') continue;
      const { findings, unreadable } = inspectFiles({ [file]: text });
      const declared = findings.filter(runs);
      // what the agent was measured to run without asking: at once, or once the folder is trusted
      const cmds = declared.filter((f) => f.when === 'open' || f.when === 'trusted');
      const hooks = cmds.filter((f) => f.kind === 'hook');
      const perms = findings.filter((f) => f.kind === 'permissions');
      // A check on the reader itself: text that spells a command where it found none.
      const suspect = !declared.length && !unreadable.length && /(^|[\s"'])command["']?\s*[:=]/m.test(text);
      if (suspect && DEBUG) fs.appendFileSync(DEBUG, JSON.stringify({ file, shape: shape(text) }) + '\n');
      s.sampled++;
      s.rows.push({
        repo: hash(it.repository.full_name), blob: it.sha,
        unreadable: unreadable.length > 0,
        run: cmds.length,
        redirect: findings.some((f) => f.kind === 'redirect'),
        mcp: cmds.filter((f) => f.kind === 'mcp').length,
        hook: hooks.length,
        held: declared.filter((f) => f.when === 'approval').length,
        unmeasured: declared.filter((f) => f.when === 'unmeasured').length,
        hook_without_tool_use: hooks.some((f) => MEASURED_EVENTS.has(f.event)),
        any_shell: perms.some((f) => f.agent === 'claude' && f.rules.some((r) => r === 'Bash' || r === 'Bash(*)')),
        suspect,
        remote: findings.filter((f) => f.kind === 'remote').length,
        permissions: findings.some((f) => f.kind === 'permissions'),
        open: cmds.some((f) => f.when === 'open'),
        unpinned: cmds.filter((f) => f.origin?.kind === 'registry' && !f.origin.pinned).length,
        pinned: cmds.filter((f) => f.origin?.kind === 'registry' && f.origin.pinned).length,
        from_repo: cmds.filter((f) => f.origin?.kind === 'repo').length,
        literal_secret: findings.some((f) => f.literal_secrets),
      });
    }
    strata.push(s);
    console.error(`${file.padEnd(28)} size:${size.padEnd(10)} indexed ${String(s.indexed).padStart(6)}  at root ${String(s.at_root).padStart(3)}/${s.returned}  read ${s.sampled}`);
  }
}

// Each stratum's sample speaks for the files GitHub says that stratum holds.
const share = (rows, f) => (rows.length ? rows.filter(f).length / rows.length : 0);
const summary = {};
for (const file of Object.keys(KINDS)) {
  const ss = strata.filter((s) => s.file === file);
  const est = (f) => Math.round(ss.reduce((n, s) => n + s.indexed * (s.returned ? s.at_root / s.returned : 0) * share(s.rows, f), 0));
  const rows = ss.flatMap((s) => s.rows);
  summary[file] = {
    indexed_files: ss.reduce((n, s) => n + s.indexed, 0),
    sampled: rows.length,
    distinct_repositories_in_sample: new Set(rows.map((r) => r.repo)).size,
    distinct_contents_in_sample: new Set(rows.map((r) => r.blob)).size,
    in_sample: {
      starts_a_command: rows.filter((r) => r.run > 0).length,
      starts_it_in_a_fresh_clone: rows.filter((r) => r.open).length,
      only_commands_held_for_approval: rows.filter((r) => r.held > 0 && r.run === 0).length,
      only_commands_on_an_unmeasured_path: rows.filter((r) => r.unmeasured > 0 && r.run + r.held === 0).length,
      starts_an_unpinned_registry_package: rows.filter((r) => r.unpinned > 0).length,
      starts_a_pinned_registry_package: rows.filter((r) => r.pinned > 0).length,
      starts_a_script_from_the_repository: rows.filter((r) => r.from_repo > 0).length,
      has_a_hook: rows.filter((r) => r.hook > 0).length,
      has_a_hook_that_needs_no_tool_use: rows.filter((r) => r.hook_without_tool_use).length,
      widens_permissions: rows.filter((r) => r.permissions).length,
      sends_model_traffic_where_the_repository_says: rows.filter((r) => r.redirect).length,
      allows_any_shell_command: rows.filter((r) => r.any_shell).length,
      spells_a_command_the_reader_did_not_find: rows.filter((r) => r.suspect).length,
      holds_a_literal_credential: rows.filter((r) => r.literal_secret).length,
      could_not_be_parsed: rows.filter((r) => r.unreadable).length,
    },
    estimated: {
      at_repository_root: est(() => true),
      starts_a_command: est((r) => r.run > 0),
      starts_it_in_a_fresh_clone: est((r) => r.open),
      starts_an_unpinned_registry_package: est((r) => r.unpinned > 0),
      widens_permissions: est((r) => r.permissions),
      sends_model_traffic_where_the_repository_says: est((r) => r.redirect),
      allows_any_shell_command: est((r) => r.any_shell),
      holds_a_literal_credential: est((r) => r.literal_secret),
    },
  };
}
const out = {
  taken: new Date().toISOString(),
  method: 'GitHub code search (default branches, as indexed), stratified by file size; first results of each stratum, exact file at repository root only; classified by agentcrash inspect; nothing executed',
  per_stratum: PER,
  summary,
  strata: strata.map(({ rows, ...s }) => s),
};
fs.mkdirSync(OUT.replace(/[^/]*$/, '') || '.', { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
