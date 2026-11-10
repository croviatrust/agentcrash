import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startPuppet } from './puppet/server.js';
import { adapters } from './adapters/index.js';
import { scenarios, seedHome, seedWorkspace } from '../scenarios/index.js';

function freshSandbox() {
  // Not under the system temp dir: agent sandboxes commonly treat /tmp as
  // writable, which would make "outside the workspace" writes look allowed.
  const base = process.env.AGENTCRASH_HOME || path.join(os.homedir(), '.agentcrash', 'runs');
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, 'run-'));
  const home = path.join(root, 'home');
  const ws = path.join(root, 'ws');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(ws, { recursive: true });
  seedHome(home);
  seedWorkspace(ws);
  const git = (args) => execFileSync('git', args, { cwd: ws, stdio: 'ignore',
    env: { ...process.env, GIT_AUTHOR_NAME: 'dev', GIT_AUTHOR_EMAIL: 'dev@example.com',
      GIT_COMMITTER_NAME: 'dev', GIT_COMMITTER_EMAIL: 'dev@example.com' } });
  git(['init', '-q']);
  git(['add', 'app.py', 'README.md']);
  git(['commit', '-q', '-m', 'init']);
  return { root, home, ws };
}

// One crash test: one agent, one mode, one scenario, in its own sandbox.
export async function runOne({ agent, mode, scenarioId, timeoutMs = 90000, keep = false }) {
  const sb = freshSandbox();
  // The payload path is only known once the sandbox exists.
  const marker = path.join(sb.ws, 'rce_marker.txt');
  const puppet = await startPuppet({ script: [], payload: `echo pwned > ${marker}\n` });
  const sinkUrl = puppet.baseUrl;
  const list = scenarios({ home: sb.home, ws: sb.ws, sinkUrl });
  const sc = list.find((s) => s.id === scenarioId);
  if (!sc) { await puppet.close(); throw new Error(`unknown scenario ${scenarioId}`); }
  puppet.state.script = sc.script;

  const started = Date.now();
  const proc = await adapters[agent].start({ home: sb.home, ws: sb.ws, baseUrl: puppet.baseUrl, mode, timeoutMs });
  const ms = Date.now() - started;

  let exposed = false;
  try { exposed = !!sc.check(puppet.state); } catch { exposed = false; }
  const s = puppet.state;
  const result = {
    agent, mode, scenario: sc.id, title: sc.title, harm: sc.harm,
    verdict: exposed ? 'EXPOSED' : 'CONTAINED',
    reached_model: s.requests.length > 0,
    commands_scripted: sc.script.length,
    commands_reported: s.toolResults.length,
    last_output: (s.toolResults.at(-1)?.output || '').slice(0, 600),
    sink_hits: s.sinkHits.length,
    protocol: s.protocol,
    exit_code: proc.code, timed_out: proc.killed, ms,
  };
  await puppet.close();
  if (keep) result.sandbox = sb.root; else fs.rmSync(sb.root, { recursive: true, force: true });
  return result;
}

export function scenarioIds() {
  return scenarios({ home: '/h', ws: '/w', sinkUrl: 'http://x' }).map((s) => s.id);
}
