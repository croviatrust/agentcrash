// The roll cage: run a coding agent in a namespace where the things the crash
// test goes after are not there to be taken.
//
//   - your home is an empty tmpfs; only the agent's own state, the toolchains on
//     your PATH and ~/.gitconfig are put back
//   - the workspace is the only writable part of your disk; .git is read-only
//     and .env files are replaced by empty ones
//   - the environment is an allow-list
//   - there is no network except a proxy that dials an allow-list of hosts
//   - no host processes, no /run sockets (docker, ssh-agent, keyring)
//
// Linux only for now: it is bubblewrap doing the namespaces.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { ttyFilter } from './seccomp.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PROXY_PORT = 3128;

// What each agent keeps under your home, and where its model lives.
export const PROFILES = {
  claude: { env: /^(ANTHROPIC_|CLAUDE_|DISABLE_|AWS_REGION$|CLOUD_ML_REGION$)/, state: ['.claude/', '.claude.json', '.local/share/claude/', '.local/state/claude/', '.cache/claude/'], hosts: ['*.anthropic.com', 'claude.ai', '*.claude.ai', '*.claude.com'] },
  codex: { env: /^(OPENAI_|CODEX_)/, state: ['.codex/'], hosts: ['*.openai.com', 'chatgpt.com', '*.chatgpt.com'] },
  gemini: { env: /^(GEMINI_|GOOGLE_)/, state: ['.gemini/'], hosts: ['*.googleapis.com', 'accounts.google.com'] },
  qwen: { env: /^(OPENAI_|QWEN_|DASHSCOPE_)/, state: ['.qwen/'], hosts: ['*.qwen.ai', '*.aliyuncs.com'] },
  opencode: { env: /^(OPENCODE_|ANTHROPIC_API_KEY$|OPENAI_API_KEY$)/, state: ['.config/opencode/', '.local/share/opencode/', '.local/state/opencode/', '.cache/opencode/'], hosts: ['opencode.ai', '*.opencode.ai', 'models.dev'] },
  crush: { env: /^(CRUSH_|ANTHROPIC_API_KEY$|OPENAI_API_KEY$)/, state: ['.config/crush/', '.local/share/crush/'], hosts: ['*.charm.sh', '*.charm.land'] },
};

// Toolchains that live under a home directory and are safe to show read-only.
const TOOLCHAINS = ['.nvm', '.volta', '.fnm', '.asdf', '.local/share/mise', '.bun', '.deno', '.cargo/bin', '.rustup', '.pyenv', '.sdkman', '.npm-global', '.local/bin', '.local/lib', 'go/bin'];
// The environment is an allow-list: enough to find and run tools, plus the
// agent's own variables. Everything else you exported stays outside.
const PASS_ENV = /^(PATH|LANG|LANGUAGE|LC_[A-Z_]+|TERM|TERM_PROGRAM|COLORTERM|TZ|USER|LOGNAME|SHELL|EDITOR|VISUAL|PAGER|SSL_CERT_FILE|SSL_CERT_DIR|NODE_EXTRA_CA_CERTS|XDG_(CONFIG|DATA|CACHE|STATE)_HOME|NVM_DIR|NVM_BIN|VOLTA_HOME|FNM_DIR|FNM_MULTISHELL_PATH|ASDF_DIR|ASDF_DATA_DIR|MISE_DATA_DIR|BUN_INSTALL|PNPM_HOME|CARGO_HOME|RUSTUP_HOME|GOPATH|GOROOT|PYENV_ROOT|JAVA_HOME)$/;
export function cageEnv(env, profile, extra = []) {
  const own = PROFILES[profile]?.env;
  return Object.fromEntries(Object.entries(env).filter(([k]) => PASS_ENV.test(k) || own?.test(k) || extra.includes(k)));
}
// Other places a whole disk of someone's files tends to be mounted.
const ELSEWHERE = ['/mnt', '/media', '/root'];
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_FILE_OK = /\.(example|sample|template|dist)$/;
const SKIP_DIRS = new Set(['node_modules', '.git', '.venv', 'venv', 'vendor', 'target', 'dist', 'build']);

export function cageAvailable() {
  if (process.platform !== 'linux') return { ok: false, why: 'the cage is Linux-only for now (it is built on bubblewrap)' };
  const v = spawnSync('bwrap', ['--version'], { encoding: 'utf8' });
  if (v.error || v.status !== 0) return { ok: false, why: 'bubblewrap is not installed (apt install bubblewrap / dnf install bubblewrap)' };
  const t = spawnSync('bwrap', ['--unshare-user', '--unshare-net', '--ro-bind', '/', '/', 'true'], { encoding: 'utf8' });
  if (t.status !== 0) {
    const said = (t.stderr || '').trim().split('\n').pop();
    // Ubuntu 24.04 and later keep unprivileged user namespaces behind AppArmor.
    const hint = /permission denied|not permitted/i.test(said) ? ' (on Ubuntu 24.04+: sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0)' : '';
    return { ok: false, why: `bubblewrap cannot create a namespace here: ${said}${hint}` };
  }
  return { ok: true };
}

const inside = (p, dir) => p === dir || p.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

// Every .env within a few levels of the workspace root.
export function envFiles(ws, depth = 4) {
  const out = [];
  const walk = (dir, d) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (d < depth && !SKIP_DIRS.has(e.name)) walk(p, d + 1); }
      else if (e.isFile() && ENV_FILE.test(e.name) && !ENV_FILE_OK.test(e.name)) out.push(p);
    }
  };
  walk(ws, 1);
  return out;
}

function which(cmd, PATH) {
  if (cmd.includes('/')) return fs.existsSync(cmd) ? path.resolve(cmd) : null;
  for (const dir of (PATH || '').split(':')) {
    const p = path.join(dir, cmd);
    try { fs.accessSync(p, fs.constants.X_OK); if (fs.statSync(p).isFile()) return p; } catch { /* next */ }
  }
  return null;
}

// Where a binary under your home really lives, so that directory can be shown.
function installRoot(real) {
  const parts = real.split(path.sep);
  const nm = parts.indexOf('node_modules');
  return nm > 0 ? parts.slice(0, nm + 1).join(path.sep) : path.dirname(real);
}

// Build the bubblewrap command line. Nothing is started here.
export function cage({ cmd, args = [], home, ws, env, gateDir, profile, opts = {} }) {
  home = fs.realpathSync(home); ws = fs.realpathSync(ws);
  if (inside(home, ws)) throw new Error(`refusing to cage: the workspace ${ws} contains your home directory`);
  const p = PROFILES[profile] || { state: [] };
  const net = opts.net !== 'open';
  // On a terminal the agent stays attached to it (resizes, job control), with
  // a seccomp filter in place of the detachment that otherwise stops it typing
  // into your shell. The filter is handed to bubblewrap on descriptor 3.
  const filter = opts.tty ? ttyFilter() : null;
  let seccomp = null;
  if (filter) { seccomp = path.join(gateDir, 'tty.bpf'); fs.writeFileSync(seccomp, filter); }
  const b = ['--die-with-parent', ...(seccomp ? ['--seccomp', '3'] : ['--new-session']), '--unshare-user', '--unshare-pid', '--unshare-ipc', '--unshare-uts', '--hostname', 'cage',
    '--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--tmpfs', '/run', '--tmpfs', home];
  for (const d of ELSEWHERE) if (fs.existsSync(d) && !inside(home, d)) b.push('--tmpfs', d);
  if (net) b.push('--unshare-net');
  else for (const f of ['/run/systemd/resolve', '/run/resolvconf', '/run/NetworkManager']) if (fs.existsSync(f)) b.push('--ro-bind', f, f);

  const shown = [];
  const show = (flag, src) => {
    if (!fs.existsSync(src) || shown.some((s) => inside(src, s.src) && (s.flag === flag || s.flag === '--bind'))) return;
    b.push(flag, src, src); shown.push({ flag, src });
  };

  // Read-only: toolchains, the directories on PATH, the binaries themselves.
  if ([home, ...ELSEWHERE].some((d) => inside(ws, d))) b.push('--dir', ws);
  for (const t of TOOLCHAINS) show('--ro-bind', path.join(home, t));
  for (const dir of (env.PATH || '').split(':')) {
    if (!dir || !inside(dir, home) || inside(ws, dir)) continue;
    // An install prefix (bin/ beside lib/) is shown whole: its bin/ is symlinks
    // into lib/. Never ~/.local itself, which also holds keyrings and app data.
    const prefix = path.dirname(dir);
    const whole = path.basename(dir) === 'bin' && prefix !== home && prefix !== path.join(home, '.local') && fs.existsSync(path.join(prefix, 'lib'));
    show('--ro-bind', whole ? prefix : dir);
  }
  // The agent and node are put back wherever the cage has just emptied the
  // place they are installed in: your home, and /tmp or /run as well (an
  // `npm install` into a scratch directory). A binary dropped straight into
  // one of those brings only itself, never the directory around it.
  const bin = which(cmd, env.PATH);
  for (const exe of [bin, process.execPath]) {
    if (!exe) continue;
    const real = fs.realpathSync(exe);
    const emptied = [home, '/tmp', '/run', ...ELSEWHERE].find((d) => inside(real, d));
    if (!emptied) continue;
    const root = installRoot(real);
    show('--ro-bind', root === emptied ? real : root);
  }
  show('--ro-bind', path.join(home, '.gitconfig'));
  for (const extra of opts.ro || []) show('--ro-bind', path.resolve(extra));

  // Read-write: what the agent itself keeps between sessions.
  for (const s of p.state) {
    const full = path.join(home, s);
    if (s.endsWith('/')) fs.mkdirSync(full, { recursive: true });
    show('--bind', full.replace(/\/$/, ''));
  }
  for (const extra of opts.rw || []) show('--bind', path.resolve(extra));

  // The workspace, minus what a hijacked model goes for first.
  b.push('--bind', ws, ws);
  const git = path.join(ws, '.git');
  if (fs.existsSync(git)) {
    if (!opts.gitWrite) b.push('--ro-bind', git, git);
    // Even when commits are allowed: hooks and config run as you, later, outside.
    else for (const f of ['hooks', 'config']) if (fs.existsSync(path.join(git, f))) b.push('--ro-bind', path.join(git, f), path.join(git, f));
  }
  const hidden = opts.showEnv ? [] : envFiles(ws);
  if (hidden.length) {
    const empty = path.join(gateDir, 'empty');
    fs.writeFileSync(empty, '');
    for (const f of hidden) b.push('--ro-bind', empty, f);
  }

  // The gate socket and the relay that reaches it.
  b.push('--ro-bind', gateDir, '/run/agentcrash', '--ro-bind', HERE, '/run/agentcrash-lib', '--chdir', ws);
  const proxy = `http://127.0.0.1:${PROXY_PORT}`;
  const given = env;
  env = cageEnv(env, profile, opts.env);
  // Ports of your own machine (a local model server) appear inside on the same
  // loopback address, so they are reached directly, not through the proxy.
  const local = net ? (opts.local || []).map(Number).filter((n) => n > 0 && n < 65536 && n !== PROXY_PORT) : [];
  const direct = local.length ? '127.0.0.1,localhost' : '';
  const caged = net
    ? { ...env, HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy, NO_PROXY: direct, no_proxy: direct }
    : { ...env };
  caged.HOME = home; caged.PWD = ws; caged.AGENTCRASH_CAGE = '1';
  const run = net
    ? [process.execPath, '/run/agentcrash-lib/relay.js', '/run/agentcrash/gate.sock', [PROXY_PORT, ...local].join(','), '--', cmd, ...args]
    : [cmd, ...args];
  return { cmd: 'bwrap', args: [...b, '--', ...run], env: caged, hidden, missing: bin ? null : cmd, seccomp, local, dropped: Object.keys(given).filter((k) => !(k in env)) };
}
