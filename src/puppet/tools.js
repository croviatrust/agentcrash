// Find, among the tools an agent offers, the one that runs a shell command and
// the one that reads a file, and build a call each agent's own schema accepts.
// Agents name these differently; the puppet must not depend on one vendor.
const SHELL_NAMES = ['Bash', 'bash', 'run_shell_command', 'exec_command', 'shell', 'execute_command',
  'run_terminal_cmd', 'run_command', 'terminal', 'execute_bash', 'local_shell'];
const READ_NAMES = ['Read', 'read', 'read_file', 'view', 'View', 'cat', 'fs_read', 'open_file'];
const COMMAND_KEYS = ['command', 'cmd', 'script', 'input'];
const PATH_KEYS = ['file_path', 'filePath', 'path', 'absolute_path', 'absolutePath', 'target_file', 'filename', 'file'];

function pick(tools, names, pattern, keys) {
  const usable = tools.filter((t) => keys.some((k) => k in (t.properties || {})));
  for (const n of names) { const t = usable.find((x) => x.name === n); if (t) return t; }
  return usable.find((t) => pattern.test(t.name)) || null;
}

function filler(schema) {
  const type = Array.isArray(schema?.type) ? schema.type[0] : schema?.type;
  if (schema?.enum?.length) return schema.enum[0];
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return schema?.minimum ?? 1;
  if (type === 'array') return [];
  if (type === 'object') return {};
  return 'run';
}

function build(tool, keys, value) {
  const props = tool.properties || {};
  const key = keys.find((k) => k in props);
  const args = {};
  for (const r of tool.required || []) if (r !== key) args[r] = filler(props[r]);
  const type = Array.isArray(props[key]?.type) ? props[key].type[0] : props[key]?.type;
  args[key] = type === 'array' ? ['bash', '-lc', value] : value;
  return { name: tool.name, args };
}

// tools: [{name, properties, required}]. Returns {shell?, read?}: for each kind
// the agent offers, a function turning an attempt into {name, args}.
export function offeredTools(tools) {
  const list = (tools || []).filter((t) => t && t.name);
  const shell = pick(list, SHELL_NAMES, /shell|bash|exec|terminal|command/i, COMMAND_KEYS);
  const read = pick(list.filter((t) => t !== shell), READ_NAMES, /^(read|view)|read_?file/i, PATH_KEYS);
  const o = {};
  if (shell) o.shell = (a) => build(shell, COMMAND_KEYS, a.command);
  if (read) o.read = (a) => build(read, PATH_KEYS, a.path);
  return o;
}
