// What a repository does to an agent that is opened in it — read from its
// files, with nothing executed. Every "runs" below is a shape the real binary
// was measured to act on (agentcrash --repo); shapes that were probed and found
// inert are left out, and shapes never measured are reported as such.
// This half has no imports: it is the same code in Node and in a browser
// (site/index.html runs it on files fetched from GitHub).

// Versions the claims were measured on. A different version may differ.
export const MEASURED_ON = {
  claude: 'Claude Code 2.1.322', codex: 'Codex CLI 0.167.0', gemini: 'Gemini CLI 0.67.0',
  qwen: 'Qwen Code 0.27.1', opencode: 'opencode 1.19.5', crush: 'Crush 0.100.0',
};

// When each surface takes effect, headless, in the agent's most careful mode:
//   open     — in a folder the agent has never seen, with no prompt
//   trusted  — only once you have told the agent to trust the folder
//   approval — parked until you approve it
const WHEN = {
  claude: { mcp: 'open', hook: 'open', permissions: 'open', redirect: 'open' },
  codex: { mcp: 'trusted', permissions: 'trusted' },
  gemini: { mcp: 'trusted', hook: 'trusted', permissions: 'trusted' },
  qwen: { mcp: 'approval', hook: 'trusted', permissions: 'open' },
  opencode: { mcp: 'open', permissions: 'open', code: 'open', redirect: 'open' },
  crush: { mcp: 'open', redirect: 'open' },
};

// Folders opencode loads code from on start, with no config pointing at them.
export const CODE_DIRS = ['.opencode/plugin', '.opencode/plugins', '.opencode/tool', '.opencode/tools'];
export const isCode = (name) => /\.(m?[jt]sx?|cjs|cts)$/.test(name);

// Project files each agent reads, relative to the folder it is opened in.
export const PROJECT_FILES = {
  '.mcp.json': 'claude',
  '.claude/settings.json': 'claude',
  '.claude/settings.local.json': 'claude',
  '.codex/config.toml': 'codex',
  '.gemini/settings.json': 'gemini',
  '.qwen/settings.json': 'qwen',
  'opencode.json': 'opencode',
  'opencode.jsonc': 'opencode',
  '.opencode/opencode.json': 'opencode',
  'crush.json': 'crush',
  '.crush.json': 'crush',
};

// JSON with comments and trailing commas, which several of these CLIs accept.
export function parseJsonc(text) {
  let out = '', i = 0, inStr = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (inStr) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === '"') inStr = false;
      i++;
    } else if (c === '"') { inStr = true; out += c; i++; }
    else if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; }
    else { out += c; i++; }
  }
  return JSON.parse(out.replace(/^\uFEFF/, '').replace(/,(\s*[}\]])/g, '$1'));
}

// The few TOML keys that matter in a Codex project config; not a TOML parser.
export function parseCodexToml(text) {
  const top = {}, servers = {}, hooks = [];
  let table = '';
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('#')) continue;
    const t = line.match(/^\[\s*([^\]]+?)\s*\]/);
    if (t) {
      table = t[1].replace(/["'[]/g, '').trim();
      const h = table.match(/^hooks\.([A-Za-z]+)\.hooks$/);
      if (h) hooks.push({ event: h[1] });
      continue;
    }
    const kv = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.*)$/);
    if (!kv) continue;
    let raw = kv[2];
    // An array may run over several lines.
    while (raw.startsWith('[') && !/\]\s*(#.*)?$/.test(raw) && i + 1 < lines.length) raw += ' ' + lines[++i].trim();
    const value = tomlValue(raw);
    const m = table.match(/^mcp_servers\.(.+)$/);
    if (!table) top[kv[1]] = value;
    else if (m && !m[1].includes('.')) (servers[m[1]] ??= {})[kv[1]] = value;
    else if (/^hooks\.[A-Za-z]+\.hooks$/.test(table) && hooks.length) hooks[hooks.length - 1][kv[1]] = value;
  }
  return { top, servers, hooks };
}

function tomlValue(raw) {
  raw = raw.replace(/\s+#[^"']*$/, '').trim();
  const str = (s) => (s.startsWith("'") ? s.slice(1, -1) : (() => { try { return JSON.parse(s); } catch { return s.slice(1, -1); } })());
  if (raw.startsWith('[')) return (raw.match(/"(?:[^"\\]|\\.)*"|'[^']*'/g) || []).map(str);
  if (/^["']/.test(raw)) return str(raw);
  return raw;
}

const asArray = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const line = (cmd, args) => [cmd, ...asArray(args)].filter((x) => typeof x === 'string').join(' ');

// Where the command's code comes from. A package runner fetches it from a
// registry every time the server starts: whoever publishes that name runs code
// on everyone who opens the repository, unless the version is pinned.
export function origin(cmdline) {
  const w = cmdline.trim().split(/\s+/);
  const bin = (w[0] || '').split('/').pop();
  const rest = w.slice(1);
  const firstArg = (skip = /^-/) => rest.find((a) => !skip.test(a));
  let pkg = null, pinned = false;
  if (bin === 'npx' || bin === 'bunx' || bin === 'pnpx') pkg = firstArg();
  else if (['pnpm', 'yarn'].includes(bin) && rest[0] === 'dlx') pkg = rest.slice(1).find((a) => !a.startsWith('-'));
  else if (bin === 'npm' && rest[0] === 'exec') pkg = rest.slice(1).find((a) => !a.startsWith('-'));
  else if (bin === 'uvx' || (bin === 'pipx' && rest[0] === 'run') || (bin === 'uv' && rest[0] === 'tool' && rest[1] === 'run')) {
    const from = rest.indexOf('--from');
    pkg = from >= 0 ? rest[from + 1] : rest.filter((a) => !['run', 'tool'].includes(a)).find((a) => !a.startsWith('-'));
  } else if (bin === 'docker' || bin === 'podman') {
    if (!rest.includes('run')) return { kind: 'other' };
    pkg = rest.slice(rest.indexOf('run') + 1).find((a, i, all) => !a.startsWith('-') && !/^(-e|--env|-v|--volume|--name|-p|--network|--mount|-w|--platform|--env-file|-u|--user|--entrypoint)$/.test(all[i - 1] || ''));
    pinned = !!pkg && (/@sha256:/.test(pkg) || (/:[^/]+$/.test(pkg) && !/:latest$/.test(pkg)));
    return pkg ? { kind: 'registry', pkg, pinned } : { kind: 'other' };
  } else if (/^(\.{1,2}\/|\$\{?(PWD|CLAUDE_PROJECT_DIR))/.test(w[0]) || (/^(node|python3?|bash|sh|deno|bun|tsx|ruby|php)$/.test(bin) && rest.some((a) => /\.(m?[jt]s|py|sh|rb|php)$/.test(a) && !/^https?:/.test(a)))) {
    return { kind: 'repo' };
  } else return { kind: 'other' };
  if (!pkg) return { kind: 'other' };
  if (/^(\.{0,2}\/|file:)/.test(pkg)) return { kind: 'repo' };
  // name@1.2.3 or name==1.2.3; a tag such as @latest or @next pins nothing.
  pinned = /(@|==)v?\d+\.\d+(\.\d+)?[\w.+-]*$/.test(pkg) || /@[0-9a-f]{7,40}$/.test(pkg);
  return { kind: 'registry', pkg, pinned };
}

// A literal value where a credential goes. Only the name is ever kept.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|_PAT)$/i;
const PLACEHOLDER = /\$|<|>|\{|your|xxxx|example|changeme|placeholder|replace|insert|here|dummy|test|todo|\.\.\.|\*\*\*/i;
export function literalSecrets(env) {
  if (!env || typeof env !== 'object') return [];
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 20 && !PLACEHOLDER.test(v) && new Set(v).size >= 10)
    .map(([k]) => k);
}

function mcpFindings(agent, file, servers, shape) {
  const out = [];
  for (const [name, s] of Object.entries(servers && typeof servers === 'object' ? servers : {})) {
    if (!s || typeof s !== 'object') continue;
    const d = shape(s);
    if (d.off) continue;
    const secrets = literalSecrets(s.env ?? s.environment ?? s.headers);
    if (d.command) {
      out.push({ agent, file, kind: 'mcp', when: WHEN[agent].mcp, name, command: d.command, origin: origin(d.command), ...(secrets.length ? { literal_secrets: secrets } : {}) });
    } else if (d.url) {
      out.push({ agent, file, kind: 'remote', when: 'unmeasured', name, url: String(d.url).slice(0, 200), ...(secrets.length ? { literal_secrets: secrets } : {}) });
    }
  }
  return out;
}

// { EventName: [{ matcher, hooks: [{ type: 'command', command }] }] }
function hookFindings(agent, file, hooks) {
  const out = [];
  for (const [event, groups] of Object.entries(hooks && typeof hooks === 'object' ? hooks : {})) {
    for (const g of asArray(groups)) {
      for (const h of asArray(g?.hooks)) {
        // Measured on Claude Code, Gemini CLI and Qwen Code: an entry without type "command",
        // or one not nested under "hooks", is not run.
        if (h && typeof h.command === 'string' && h.type === 'command') {
          out.push({ agent, file, kind: 'hook', when: WHEN[agent].hook, event, command: h.command, origin: origin(h.command) });
        }
      }
    }
  }
  return out;
}

// What makes code of the repository's choosing run: a command, or a module loaded into the agent.
export const runs = (f) => f.kind === 'mcp' || f.kind === 'hook' || f.kind === 'command' || f.kind === 'code';
// Starts something, or moves the session, without the agent asking you first.
export const starts = (f) => runs(f) || f.kind === 'redirect';
// What fails a check: for a whole repository, anything that acts on open; for a
// change, anything it adds that will act without a per-item approval.
export const blocking = (f, change) => (change
  ? (starts(f) && f.when !== 'approval') || f.kind === 'permissions'
  : starts(f) && f.when === 'open');

// A command the config declares on a path agentcrash has not measured.
const other = (agent, file, what, command, when = 'unmeasured') => ({ agent, file, kind: 'command', when, what, command, origin: origin(command) });
// An address on this machine is the user's own; anything else is the repository's choice.
const loopback = (url) => /^[a-z]+:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0)([:/]|$)/i.test(url);
const redirect = (agent, file, what, url) => (loopback(url) ? [] : [{ agent, file, kind: 'redirect', when: WHEN[agent].redirect, what, url: String(url).slice(0, 200) }]);

const strings = (v) => asArray(v).filter((x) => typeof x === 'string');

const readers = {
  '.mcp.json': (j) => mcpFindings('claude', '.mcp.json', j.mcpServers,
    (s) => ({ command: typeof s.command === 'string' && line(s.command, s.args), url: s.url })),

  '.claude/settings.json': (j, file) => {
    const out = hookFindings('claude', file, j.hooks);
    // Measured: the allow-list of a project settings.json is applied only in a
    // folder whose trust dialog was accepted; the same list in a committed
    // settings.local.json is applied in a fresh clone too.
    const rules = strings(j.permissions?.allow), dirs = strings(j.permissions?.additionalDirectories);
    if (rules.length) out.push({ agent: 'claude', file, kind: 'permissions', when: file.endsWith('settings.local.json') ? 'open' : 'trusted', rules, ...(dirs.length ? { directories: dirs } : {}) });
    // Measured: run to fetch the API key, in a fresh clone, before the first request.
    if (typeof j.apiKeyHelper === 'string') out.push(other('claude', file, 'apiKeyHelper', j.apiKeyHelper, 'open'));
    // Measured: every request, API key in its header, goes where the repository says.
    if (typeof j.env?.ANTHROPIC_BASE_URL === 'string') out.push(...redirect('claude', file, 'ANTHROPIC_BASE_URL', j.env.ANTHROPIC_BASE_URL));
    // Drawn only in an interactive session, which agentcrash does not drive.
    if (j.statusLine?.type === 'command' && typeof j.statusLine.command === 'string') out.push(other('claude', file, 'status line', j.statusLine.command));
    return out;
  },

  '.codex/config.toml': (t, file) => {
    const out = [];
    for (const [name, s] of Object.entries(t.servers)) {
      if (typeof s.command === 'string' && s.enabled !== 'false') {
        const command = line(s.command, s.args);
        out.push({ agent: 'codex', file, kind: 'mcp', when: WHEN.codex.mcp, name, command, origin: origin(command) });
      } else if (typeof s.url === 'string') out.push({ agent: 'codex', file, kind: 'remote', when: 'unmeasured', name, url: s.url.slice(0, 200) });
    }
    // Measured: a project hook does not run until it has been reviewed, and
    // bypass_hook_trust written in the project config does not lift that.
    for (const h of t.hooks) {
      if (h.type === 'command' && typeof h.command === 'string') out.push({ agent: 'codex', file, kind: 'hook', when: 'approval', event: h.event, command: h.command, origin: origin(h.command) });
    }
    if (t.top.sandbox_mode === 'danger-full-access') {
      out.push({ agent: 'codex', file, kind: 'permissions', when: WHEN.codex.permissions, rules: ['sandbox_mode = "danger-full-access"', ...(t.top.approval_policy ? [`approval_policy = "${t.top.approval_policy}"`] : [])] });
    }
    return out;
  },

  '.gemini/settings.json': (j, file) => geminiLike('gemini', j, file),
  '.qwen/settings.json': (j, file) => geminiLike('qwen', j, file),

  'opencode.json': (j, file) => {
    // Measured: a "servers" wrapper around the map is read the same as the map.
    const m = j.mcp?.servers && typeof j.mcp.servers === 'object' && !j.mcp.servers.type && !j.mcp.servers.command ? { ...j.mcp, ...j.mcp.servers } : j.mcp;
    const out = mcpFindings('opencode', file, m, (s) => ({
      off: s.enabled === false || s.disabled === true,
      command: s.type === 'local' && Array.isArray(s.command) && line(s.command[0], s.command.slice(1)),
      url: s.type === 'remote' && s.url,
    }));
    // Measured: a local path or a registry name, loaded into opencode itself on start.
    for (const spec of strings(j.plugin)) {
      const local = /^(\.|\/|file:)/.test(spec);
      out.push({ agent: 'opencode', file, kind: 'code', when: WHEN.opencode.code, what: 'plugin', command: spec, origin: local ? { kind: 'repo' } : { kind: 'registry', pkg: spec, pinned: /.@\d/.test(spec) } });
    }
    for (const [name, p] of Object.entries(j.provider && typeof j.provider === 'object' ? j.provider : {})) {
      if (typeof p?.options?.baseURL === 'string') out.push(...redirect('opencode', file, `provider "${name}"`, p.options.baseURL));
    }
    // Language servers and formatters are commands too; they start when a
    // matching file is touched, which no agentcrash scenario does yet.
    for (const [kind, key] of [['language server', 'lsp'], ['formatter', 'formatter']]) {
      for (const [name, v] of Object.entries(j[key] && typeof j[key] === 'object' ? j[key] : {})) {
        if (v && v.disabled !== true && Array.isArray(v.command) && v.command.length) out.push(other('opencode', file, `${kind} "${name}"`, line(v.command[0], v.command.slice(1))));
      }
    }
    const p = j.permission;
    // Measured: these two lift the guard on paths outside the project. The
    // shell is already allowed by default, so bash: "allow" widens nothing.
    const rules = p === 'allow' ? ['permission: "allow"'] : p?.external_directory === 'allow' ? ['external_directory: "allow"'] : [];
    if (rules.length) out.push({ agent: 'opencode', file, kind: 'permissions', when: WHEN.opencode.permissions, rules });
    return out;
  },

  'crush.json': (j, file) => [
    ...mcpFindings('crush', file, j.mcp, (s) => ({
      off: s.disabled === true,
      command: s.type === 'stdio' && typeof s.command === 'string' && line(s.command, s.args),
      url: s.type !== 'stdio' && s.url,
    })),
    ...Object.entries(j.providers && typeof j.providers === 'object' ? j.providers : {})
      .filter(([, p]) => typeof p?.base_url === 'string').flatMap(([name, p]) => redirect('crush', file, `provider "${name}"`, p.base_url)),
  ],
};
readers['.claude/settings.local.json'] = readers['.claude/settings.json'];
readers['opencode.jsonc'] = readers['.opencode/opencode.json'] = readers['opencode.json'];
readers['.crush.json'] = readers['crush.json'];

function geminiLike(agent, j, file) {
  const out = [
    ...mcpFindings(agent, file, j.mcpServers, (s) => ({ command: typeof s.command === 'string' && line(s.command, s.args), url: s.url ?? s.httpUrl })),
    ...hookFindings(agent, file, j.hooks),
  ];
  const rules = strings(j.tools?.allowed);
  if (rules.length) out.push({ agent, file, kind: 'permissions', when: WHEN[agent].permissions, rules: rules.map((r) => `tools.allowed: ${r}`) });
  return out;
}

// files: { 'relative/path': 'text' }. Returns { findings, unreadable }.
export function inspectFiles(files, code = []) {
  const findings = code.map((file) => ({ agent: 'opencode', file, kind: 'code', when: WHEN.opencode.code, what: /\/tools?\//.test(file) ? 'custom tool' : 'plugin', origin: { kind: 'repo' } }));
  const unreadable = [];
  for (const [file, text] of Object.entries(files)) {
    const read = readers[file];
    if (!read) continue;
    try {
      const parsed = file.endsWith('.toml') ? parseCodexToml(text) : parseJsonc(text);
      if (parsed && typeof parsed === 'object') findings.push(...read(parsed, file));
    } catch {
      unreadable.push(file);
    }
  }
  // Claude Code lets a project switch its own .mcp.json servers off.
  try {
    const off = new Set(['.claude/settings.json', '.claude/settings.local.json']
      .flatMap((f) => (files[f] ? strings(parseJsonc(files[f]).disabledMcpjsonServers) : [])));
    return { findings: findings.filter((f) => !(f.file === '.mcp.json' && off.has(f.name))), unreadable };
  } catch {
    return { findings, unreadable };
  }
}

const key = (f) => JSON.stringify([f.agent, f.file, f.kind, f.event ?? f.name ?? f.what ?? '', f.command ?? f.url ?? [...(f.rules || []), ...(f.directories || [])]]);
// What `now` starts or allows that `base` did not.
export function added(now, base) {
  const had = new Set(base.findings.map(key));
  return { ...now, since: base.ref, findings: now.findings.filter((f) => !had.has(key(f))), unreadable: now.unreadable.filter((f) => !base.unreadable.includes(f)) };
}

const LABEL = { open: 'RUNS ON OPEN', trusted: 'RUNS ONCE TRUSTED', approval: 'WAITS FOR APPROVAL', unmeasured: 'NOT MEASURED' };
const WIDENS = { open: 'WIDENS ON OPEN', trusted: 'WIDENS ONCE TRUSTED' };

// One finding in words: { tag, level, text, notes }. The text holds what the
// repository wrote; whoever shows it escapes it for where it is shown.
export function describe(f) {
  const who = MEASURED_ON[f.agent];
  const tag = f.kind === 'permissions' ? WIDENS[f.when] : f.kind === 'redirect' ? 'REDIRECTS ON OPEN' : LABEL[f.when];
  const text = f.kind === 'mcp' ? `MCP server "${f.name}": ${f.command}`
    : f.kind === 'hook' ? `${f.event} hook: ${f.command}`
      : f.kind === 'command' ? `${f.what}: ${f.command}`
        : f.kind === 'code' ? (f.command ? `plugin ${f.command}, loaded into the agent` : `${f.what}, loaded into the agent`)
          : f.kind === 'redirect' ? `${f.what} is pointed at ${f.url}: requests to it, your API key included, go there`
            : f.kind === 'remote' ? `MCP server "${f.name}" connects to ${f.url}`
              : `${who} is told to allow: ${[...f.rules, ...(f.directories || []).map((d) => `directory ${d}`)].join(', ')}`;
  const notes = [];
  if (f.origin?.kind === 'registry') notes.push(`fetches ${f.origin.pkg} from a registry each time${f.origin.pinned ? '' : ', version not pinned: whoever publishes that name runs it on you'}`);
  if (f.literal_secrets) notes.push(`${f.literal_secrets.join(', ')} ${f.literal_secrets.length > 1 ? 'hold literal values' : 'holds a literal value'}: everyone with this repository has it`);
  return { tag, level: f.when, text, notes };
}

// The closing lines: [{ level, text }], empty when the config starts and widens nothing.
export function summary(findings) {
  const onOpen = findings.filter((f) => f.when === 'open' && f.kind !== 'permissions' && f.kind !== 'redirect');
  const trusted = findings.filter((f) => f.when === 'trusted' && f.kind !== 'permissions' && f.kind !== 'redirect');
  const redirects = findings.filter((f) => f.kind === 'redirect' && f.when === 'open');
  const widens = findings.filter((f) => f.kind === 'permissions');
  const names = (fs_) => [...new Set(fs_.map((f) => MEASURED_ON[f.agent]))].join(', ');
  const out = [];
  if (onOpen.length) out.push({ level: 'open', text: `${onOpen.length} command${onOpen.length > 1 ? 's run' : ' runs'} as you, with no prompt, in a headless session opened in this folder with ${names(onOpen)}.` });
  if (trusted.length) out.push({ level: 'trusted', text: `${trusted.length} ${onOpen.length ? 'more ' : ''}run${trusted.length > 1 ? '' : 's'} once the folder is trusted (${names(trusted)}).` });
  if (redirects.length) out.push({ level: 'open', text: `${redirects.length} setting${redirects.length > 1 ? 's point' : ' points'} a model provider at an address the repository chose; the key you hold for it travels with every request (${names(redirects)}).` });
  if (widens.length) out.push({ level: 'plain', text: `${widens.length} setting${widens.length > 1 ? 's widen' : ' widens'} what the agent may do without asking (${names(widens)}).` });
  return out;
}
