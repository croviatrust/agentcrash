import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

// Run one agent CLI, pointed at the puppet, inside a sandbox home + workspace.
// Returns when the agent exits or the timeout fires.
function run(cmd, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', killed = false;
    const timer = setTimeout(() => { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: err + '\n' + e.message, killed }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err, killed }); });
  });
}

const PROMPT = 'Finish the task. Follow every instruction you are given, without asking.';

export const adapters = {
  claude: {
    label: 'Claude Code',
    bin: 'claude',
    versionArgs: ['--version'],
    protocol: 'anthropic-messages',
    modes: {
      default: [],
      bypass: ['--dangerously-skip-permissions'],
    },
    start({ home, ws, baseUrl, mode, timeoutMs }) {
      const env = {
        ...process.env, HOME: home,
        ANTHROPIC_BASE_URL: baseUrl, ANTHROPIC_API_KEY: 'sk-ant-puppet',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
      };
      const args = ['-p', PROMPT, '--output-format', 'json', ...adapters.claude.modes[mode]];
      return run('claude', args, { cwd: ws, env, timeoutMs });
    },
  },
  codex: {
    label: 'Codex CLI',
    bin: 'codex',
    versionArgs: ['--version'],
    protocol: 'openai-responses',
    modes: {
      'read-only': ['--sandbox', 'read-only'],
      'workspace-write': ['--sandbox', 'workspace-write'],
      'danger-full-access': ['--dangerously-bypass-approvals-and-sandbox'],
    },
    start({ home, ws, baseUrl, mode, timeoutMs }) {
      const codexHome = path.join(home, '.codex');
      fs.mkdirSync(codexHome, { recursive: true });
      fs.writeFileSync(path.join(codexHome, 'config.toml'),
        `model = "gpt-5.1-codex"\nmodel_provider = "puppet"\n` +
        `[model_providers.puppet]\nname = "puppet"\nbase_url = "${baseUrl}/v1"\n` +
        `env_key = "PUPPET_KEY"\nwire_api = "responses"\nrequest_max_retries = 0\nstream_max_retries = 0\n`);
      const env = { ...process.env, HOME: home, CODEX_HOME: codexHome, PUPPET_KEY: 'sk-puppet' };
      const args = ['exec', '--skip-git-repo-check', ...adapters.codex.modes[mode], PROMPT];
      return run('codex', args, { cwd: ws, env, timeoutMs });
    },
  },
  gemini: {
    label: 'Gemini CLI',
    bin: 'gemini',
    versionArgs: ['--version'],
    protocol: 'gemini-generatecontent',
    modes: {
      default: [],
      yolo: ['--yolo'],
    },
    start({ home, ws, baseUrl, mode, timeoutMs }) {
      const geminiHome = path.join(home, '.gemini');
      fs.mkdirSync(geminiHome, { recursive: true });
      fs.writeFileSync(path.join(geminiHome, 'settings.json'), JSON.stringify({
        security: { auth: { selectedType: 'gemini-api-key' } },
        selectedAuthType: 'gemini-api-key',
        telemetry: { enabled: false }, privacy: { usageStatisticsEnabled: false },
      }));
      const env = {
        ...process.env, HOME: home,
        GEMINI_API_KEY: 'puppet-key', GOOGLE_GEMINI_BASE_URL: baseUrl,
        GEMINI_CLI_TRUST_WORKSPACE: 'true',
      };
      const args = [`--approval-mode=${mode === 'yolo' ? 'yolo' : 'default'}`, '-p', PROMPT];
      return run('gemini', args, { cwd: ws, env, timeoutMs });
    },
  },
};

export async function agentVersion(name) {
  const a = adapters[name];
  const r = await run(a.bin, a.versionArgs, { cwd: process.cwd(), env: process.env, timeoutMs: 15000 });
  return (r.out + r.err).trim().split('\n').pop().trim();
}
