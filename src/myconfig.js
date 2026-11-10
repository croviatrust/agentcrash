// --my-config: test the configuration you actually run with, instead of a
// default install. Only the keys that decide what an agent is allowed to do
// are copied into the sandbox, and anything that looks like a credential is
// replaced before it gets there. Your files are read, never written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REDACTED = '[redacted by agentcrash]';
const SECRET_KEY = /key|token|secret|password|passwd|credential|cookie|authorization/i;
const SECRET_VALUE = /^(sk-|sk_|ghp_|gho_|github_pat_|xox[baprs]-|AKIA|ya29\.|AIza|eyJ[\w-]+\.)/;

// What decides the outcome of a crash test: permissions, tool allow-lists and
// hooks. MCP servers, plugins and env blocks are left behind on purpose — they
// would start your real services, or point the run at a real model endpoint.
const SPECS = {
  claude: [{ file: '.claude/settings.json', keys: ['permissions', 'hooks'] }],
  codex: [{ file: '.codex/config.toml', toml: true }],
  gemini: [{ file: '.gemini/settings.json', keys: ['tools', 'hooks', 'coreTools', 'excludeTools', 'allowedTools'] }],
  qwen: [{ file: '.qwen/settings.json', keys: ['tools', 'hooks', 'permissions', 'coreTools', 'excludeTools', 'allowedTools'] }],
  opencode: [{ file: '.config/opencode/opencode.json', keys: ['permission', 'tools'] }],
  crush: [{ file: '.config/crush/crush.json', keys: ['permissions'] }],
};

// Codex has no JSON config: keep what governs approvals and the sandbox, drop
// the rest, so no provider, key or MCP server of yours ends up in the run.
const TOML_KEYS = /^(approval_policy|sandbox_mode)\s*=/;
const TOML_TABLES = /^\[(sandbox_workspace_write|shell_environment_policy)\]/;

// The run has its own HOME, so a hook written as ~/guard.sh would not be
// found and would silently stop guarding. Point it back at your real one.
const rehome = (cmd, home) => cmd.replace(/(^|[\s"'=:])(~|\$HOME|\$\{HOME\})(?=\/)/g, `$1${home}`);

function redact(value, home) {
  if (Array.isArray(value)) return value.map((v) => redact(v, home));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => {
      if (SECRET_KEY.test(k) && typeof v === 'string') return [k, REDACTED];
      if (k === 'command' && typeof v === 'string' && home) return [k, rehome(v, home)];
      return [k, redact(v, home)];
    }));
  }
  if (typeof value === 'string' && SECRET_VALUE.test(value)) return REDACTED;
  return value;
}

function filterToml(text) {
  const out = [];
  let section = null; // null: still at the top level of the file
  for (const line of text.split('\n')) {
    if (/^\s*\[/.test(line)) {
      section = TOML_TABLES.test(line.trim()) ? 'keep' : 'drop';
      if (section === 'keep') out.push(line);
    } else if (section === 'keep' || (section === null && TOML_KEYS.test(line.trim()))) {
      out.push(redactTomlLine(line));
    }
  }
  return out.join('\n').trim();
}

const redactTomlLine = (line) => (SECRET_KEY.test(line.split('=')[0] || '')
  ? `${line.split('=')[0]}= "${REDACTED}"` : line);

// Returns { config, files } for one agent: the redacted pieces to merge into
// the sandbox, and the list of files they came from, for the report.
export function userConfig(agent, home = os.homedir(), { hooks = true } = {}) {
  const config = {};
  const files = [];
  for (const spec of SPECS[agent] || []) {
    const src = path.join(home, spec.file);
    if (!fs.existsSync(src)) continue;
    if (spec.toml) {
      const text = filterToml(fs.readFileSync(src, 'utf8'));
      if (!text) continue;
      config[spec.file] = text;
      files.push({ file: src, kept: 'approval and sandbox settings' });
      continue;
    }
    let parsed;
    try { parsed = JSON.parse(fs.readFileSync(src, 'utf8')); } catch { continue; }
    const kept = spec.keys.filter((k) => parsed[k] !== undefined && (hooks || k !== 'hooks'));
    if (!kept.length) continue;
    config[spec.file] = redact(Object.fromEntries(kept.map((k) => [k, parsed[k]])), home);
    files.push({ file: src, kept: kept.join(', ') });
  }
  return { config, files };
}

// Your settings go underneath: the puppet provider must still win, or the run
// would talk to a real model.
export function merge(mine, ours) {
  if (!mine || typeof mine !== 'object' || Array.isArray(mine)) return ours;
  const out = { ...mine };
  for (const [k, v] of Object.entries(ours)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? merge(out[k], v) : v;
  }
  return out;
}
