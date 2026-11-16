// The GitHub Action: agentcrash inspect on a pull request or a push, reported
// as annotations and a job summary. Everything it prints about the repository
// is untrusted text and is escaped before GitHub sees it.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectDir, inspectRef, added, renderInspect, blocking, MEASURED_ON } from '../src/inspect.js';

const env = process.env;
const dir = path.resolve(env.GITHUB_WORKSPACE || '.', env.AC_PATH || '.');
const failOn = ['added', 'any', 'never'].includes(env.AC_FAIL_ON) ? env.AC_FAIL_ON : 'added';
const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
const isSha = (s) => /^[0-9a-f]{40,64}$/.test(s || '') && !/^0+$/.test(s);

// What the change is measured against. On a pull request the checkout is the
// merge commit: its first parent is the base as merged, which is what counts.
function baseRef() {
  if (env.AC_BASE) return env.AC_BASE;
  if (env.AC_EVENT?.startsWith('pull_request')) {
    try {
      const parents = git(['cat-file', '-p', 'HEAD']).split('\n\n')[0].split('\n').filter((l) => l.startsWith('parent ')).map((l) => l.slice(7));
      if (parents.length === 2 && isSha(parents[0])) return parents[0];
    } catch { /* not a git checkout */ }
    if (isSha(env.AC_PR_BASE)) return env.AC_PR_BASE;
  }
  if (env.AC_EVENT === 'push' && isSha(env.AC_BEFORE)) return env.AC_BEFORE;
  return null;
}

function have(ref) {
  try { git(['cat-file', '-e', `${ref}^{commit}`]); return true; } catch { return false; }
}

let result = inspectDir(dir);
let since = failOn === 'any' ? null : baseRef();
if (since && !have(since) && isSha(since)) {
  try { git(['-c', 'protocol.version=2', 'fetch', '--no-tags', '--depth=1', 'origin', since]); } catch { /* reported below */ }
}
let note = '';
if (since && have(since)) {
  result = added(result, inspectRef(dir, since));
} else {
  if (since) note = `The base commit ${since.slice(0, 12)} could not be read, so the whole repository is reported and nothing fails. Check out with \`fetch-depth: 0\`, or pass \`base\`.`;
  since = null;
}
const change = !!since;
const enforce = failOn !== 'never' && (change || failOn === 'any');
const bad = result.findings.filter((f) => blocking(f, change));

// Workflow-command escaping: an MCP name or a hook command is attacker text.
const clean = (s) => String(s).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, '');
const data = (s) => clean(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const prop = (s) => data(s).replace(/:/g, '%3A').replace(/,/g, '%2C');
const html = (s) => clean(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const say = (f) => (f.kind === 'mcp' ? `MCP server "${f.name}" starts: ${f.command}`
  : f.kind === 'hook' ? `${f.event} hook runs: ${f.command}`
    : f.kind === 'command' ? `${f.what} runs: ${f.command}`
      : f.kind === 'code' ? (f.command ? `plugin ${f.command} is loaded into the agent` : `${f.what} is loaded into the agent`)
        : f.kind === 'redirect' ? `${f.what} sends model requests, API key included, to ${f.url}`
          : f.kind === 'remote' ? `MCP server "${f.name}" connects to ${f.url}`
            : `allows without asking: ${[...(f.rules || []), ...(f.directories || []).map((d) => `directory ${d}`)].join(', ')}`);
const whenText = { open: 'on open, no prompt', trusted: 'once the folder is trusted', approval: 'after its own approval', unmeasured: 'not measured' };

for (const f of result.findings) {
  const level = bad.includes(f) ? (enforce ? 'error' : 'warning') : 'notice';
  const text = `${say(f)} (${MEASURED_ON[f.agent]}: ${whenText[f.when] ?? f.when})`;
  console.log(`::${level} file=${prop(path.posix.join(env.AC_PATH && env.AC_PATH !== '.' ? env.AC_PATH : '', f.file))},title=${prop(change ? 'agentcrash: added by this change' : 'agentcrash')}::${data(text.slice(0, 600))}`);
}

const text = renderInspect({ ...result, dir: env.AC_PATH || '.', since: since ? since.slice(0, 12) : undefined }, { color: false });
console.log(text);

const summary = [
  `### agentcrash inspect${change ? ': what this change adds' : ''}`,
  '',
  bad.length
    ? `**${bad.length} ${bad.length > 1 ? 'things' : 'thing'}** ${change ? 'added here' : 'in this repository'} ${bad.length > 1 ? 'act' : 'acts'} on a coding agent opened in this repository without that agent asking first.`
    : (change ? 'This change adds no command, no loaded code, no model endpoint and no widened permission for the six agents measured.' : 'Nothing in this repository acts on open in the six agents measured.'),
  '',
  `<pre>${html(text)}</pre>`,
  note ? `\n> ${note}\n` : '',
  'Nothing in the repository was executed. [agentcrash](https://github.com/croviatrust/agentcrash)',
].join('\n');
if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summary + '\n');
if (env.GITHUB_OUTPUT) fs.appendFileSync(env.GITHUB_OUTPUT, `findings=${result.findings.length}\nblocking=${bad.length}\n`);
if (note) console.log(`::warning title=agentcrash::${data(note)}`);
process.exit(enforce && bad.length ? 1 : 0);
