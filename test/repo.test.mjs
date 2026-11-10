import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { adapters } from '../src/adapters/index.js';
import { repoVectors } from '../scenarios/repo.js';

const sandbox = () => fs.mkdtempSync(path.join(os.tmpdir(), 'repo-seed-'));

test('every repo seed writes project config inside the workspace only', () => {
  for (const [agent, adapter] of Object.entries(adapters)) {
    for (const [id, seed] of Object.entries(adapter.repo || {})) {
      assert.ok(repoVectors.some((v) => v.id === id), `${agent}: unknown vector ${id}`);
      const ws = sandbox();
      const home = sandbox();
      seed({ ws, home, cmd: 'echo marker' });
      const files = fs.readdirSync(ws, { recursive: true })
        .filter((f) => fs.statSync(path.join(ws, f)).isFile());
      assert.ok(files.length > 0, `${agent}/${id}: wrote nothing`);
      for (const f of files) JSON.parse(fs.readFileSync(path.join(ws, f), 'utf8'));
      assert.equal(fs.readdirSync(home).length, 0, `${agent}/${id}: touched HOME`);
    }
  }
});

test('the executable vectors carry the command, the escalation vector does not', () => {
  for (const [agent, adapter] of Object.entries(adapters)) {
    for (const [id, seed] of Object.entries(adapter.repo || {})) {
      const ws = sandbox();
      seed({ ws, home: sandbox(), cmd: 'echo CMD-MARKER' });
      const text = fs.readdirSync(ws, { recursive: true })
        .map((f) => path.join(ws, f))
        .filter((f) => fs.statSync(f).isFile())
        .map((f) => fs.readFileSync(f, 'utf8'))
        .join('\n');
      assert.equal(text.includes('CMD-MARKER'), id !== 'project-permissions', `${agent}/${id}`);
    }
  }
});
