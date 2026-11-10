import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { userConfig, merge } from '../src/myconfig.js';

function fakeHome(tree) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myconfig-'));
  for (const [rel, body] of Object.entries(tree)) {
    const f = path.join(home, rel);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return home;
}

test('keeps permission/hook/mcp keys and drops everything else', () => {
  const home = fakeHome({
    '.claude/settings.json': {
      permissions: { defaultMode: 'bypassPermissions' },
      hooks: { SessionStart: [] },
      theme: 'dark',
      feedbackSurveyState: { lastShown: 123 },
    },
  });
  const { config, files } = userConfig('claude', home);
  const kept = config['.claude/settings.json'];
  assert.deepEqual(Object.keys(kept).sort(), ['hooks', 'permissions']);
  assert.equal(files.length, 1);
});

test('redacts secret-looking keys and values', () => {
  const home = fakeHome({
    '.claude/settings.json': {
      env: { ANTHROPIC_BASE_URL: 'https://real.example', ANTHROPIC_API_KEY: 'sk-ant-realrealreal' },
      permissions: { allow: ['Bash'], apiKeyHelper: 'echo sk-secret', note: 'ghp_deadbeefdeadbeef' },
    },
  });
  const { config } = userConfig('claude', home);
  const text = JSON.stringify(config);
  assert.ok(!text.includes('sk-ant-realrealreal'));
  assert.ok(!text.includes('sk-secret'));
  assert.ok(!text.includes('ghp_deadbeefdeadbeef'));
  assert.ok(!text.includes('real.example'), 'an env block could redirect the run to a real endpoint');
  assert.ok(text.includes('Bash'), 'permission rules survive');
});

test('MCP servers and plugins are never carried into the run', () => {
  const home = fakeHome({
    '.gemini/settings.json': { mcpServers: { db: { command: 'psql' } }, tools: { allowed: ['run_shell_command'] } },
    '.config/opencode/opencode.json': { plugin: ['x'], mcp: { db: {} }, permission: { bash: 'allow' } },
  });
  assert.deepEqual(Object.keys(userConfig('gemini', home).config['.gemini/settings.json']), ['tools']);
  assert.deepEqual(Object.keys(userConfig('opencode', home).config['.config/opencode/opencode.json']), ['permission']);
});

test('codex toml keeps approval/sandbox settings, drops providers and MCP', () => {
  const home = fakeHome({
    '.codex/config.toml':
      'model = "gpt-5"\napproval_policy = "never"\nsandbox_mode = "danger-full-access"\n' +
      '[model_providers.openai]\napi_key = "sk-real-openai-key"\nbase_url = "https://api.openai.com"\n' +
      '[sandbox_workspace_write]\nnetwork_access = true\n' +
      '[mcp_servers.helper]\ncommand = "node"\n',
  });
  const toml = userConfig('codex', home).config['.codex/config.toml'];
  assert.ok(toml.includes('sandbox_mode = "danger-full-access"'));
  assert.ok(toml.includes('network_access = true'));
  assert.ok(!toml.includes('model ='));
  assert.ok(!toml.includes('sk-real-openai-key'));
  assert.ok(!toml.includes('model_providers'));
  assert.ok(!toml.includes('mcp_servers'));
});

test('merge puts the puppet provider on top of your settings', () => {
  const mine = { approvalMode: 'yolo', provider: { mine: { key: 'x' } } };
  const ours = { provider: { puppet: { base: 'y' } } };
  const out = merge(mine, ours);
  assert.equal(out.approvalMode, 'yolo');
  assert.ok(out.provider.puppet, 'ours wins where they overlap');
});

test('missing config yields nothing, not a crash', () => {
  const home = fakeHome({});
  const { config, files } = userConfig('gemini', home);
  assert.deepEqual(config, {});
  assert.equal(files.length, 0);
});

test('the agent under test gets an allow-listed environment, not yours', async () => {
  const { baseEnv } = await import('../src/adapters/index.js');
  const env = baseEnv({
    PATH: '/bin', LANG: 'C', LC_ALL: 'C',
    OPENAI_API_KEY: 'x', GH_TOKEN: 'y', AWS_SECRET_ACCESS_KEY: 'z',
    // Not secrets, but each one would take the run out of the sandbox.
    CLAUDE_CONFIG_DIR: '/real', CODEX_HOME: '/real', CLAUDE_CODE_USE_BEDROCK: '1', AWS_PROFILE: 'prod',
    OPENAI_BASE_URL: 'https://real', HTTPS_PROXY: 'http://proxy', NODE_OPTIONS: '--require /x',
  });
  assert.deepEqual(Object.keys(env).sort(), ['LANG', 'LC_ALL', 'PATH']);
});

test('a hook reached through ~ or $HOME still points at the real script', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-home-'));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
      { type: 'command', command: '~/guard.sh --strict' },
      { type: 'command', command: 'python3 "$HOME/hooks/check.py" ~/x' },
      { type: 'command', command: 'echo a~b $HOMEX' },
    ] }] },
  }));
  const { config } = userConfig('claude', home);
  const cmds = config['.claude/settings.json'].hooks.PreToolUse[0].hooks.map((h) => h.command);
  assert.deepEqual(cmds, [
    `${home}/guard.sh --strict`,
    `python3 "${home}/hooks/check.py" ${home}/x`,
    'echo a~b $HOMEX',
  ]);
  fs.rmSync(home, { recursive: true, force: true });
});

test('an agent that is not installed has no version, and asking does not touch HOME', async () => {
  const { adapters, agentVersion } = await import('../src/adapters/index.js');
  adapters.ghost = { bin: 'agentcrash-no-such-binary', versionArgs: ['--version'] };
  assert.equal(await agentVersion('ghost'), null);
  delete adapters.ghost;
});

test('--no-hooks leaves your hooks out and keeps the rest', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mycfg-'));
  fs.mkdirSync(path.join(home, '.claude'));
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { deny: ['Read(./.env)'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/guard.sh' }] }] },
  }));
  const { config, files } = userConfig('claude', home, { hooks: false });
  assert.deepEqual(Object.keys(config['.claude/settings.json']), ['permissions']);
  assert.equal(files[0].kept, 'permissions');
  assert.ok(userConfig('claude', home).config['.claude/settings.json'].hooks);
});
