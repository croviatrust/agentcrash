import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runTrial } from '../agents/trial.mjs';
const project = fileURLToPath(new URL('../', import.meta.url));
test('external-facing trial executes the real CLI and publishes only synthetic evidence', () => {
  const report = runTrial();
  assert.equal(report.passed, true); assert.equal(report.cases.length, 4);
  assert.ok(report.cases.every(c => c.passed)); assert.equal(report.telemetry, 'none'); assert.equal(report.adoption, 'not measured');
  const text = JSON.stringify(report); assert.ok(!text.includes(os.homedir())); assert.ok(!text.includes('agentcrash-trial-'));
  assert.match(report.contentHash, /^[a-f0-9]{64}$/);
});
test('trial refuses to overwrite files and works from a caller directory outside the project', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trial-caller-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'receipt.json'), script = path.join(project, 'agents/trial.mjs');
  execFileSync(process.execPath, [script, '--output', target], { cwd: dir });
  const original = fs.readFileSync(target, 'utf8');
  const retry = spawnSync(process.execPath, [script, '--output', target], { cwd: dir, encoding: 'utf8' });
  assert.notEqual(retry.status, 0); assert.equal(fs.readFileSync(target, 'utf8'), original);
});
