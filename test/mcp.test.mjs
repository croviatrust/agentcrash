import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { handle, callTool, TOOLS } from '../src/mcp.js';

const BIN = path.resolve('bin/agentcrash.js');
const rpc = (lines, cwd) => spawnSync(process.execPath, [BIN, 'mcp'], { cwd, input: lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', encoding: 'utf8' })
  .stdout.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

test('mcp: initialize, list and call over stdio; notifications get no answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { docs: { command: 'npx', args: ['-y', 'thing'] } } }));
  const out = rpc([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'inspect_repository', arguments: {} } },
    'not json',
    { jsonrpc: '2.0', id: 4, method: 'resources/list' },
    { jsonrpc: '2.0', id: 5, method: 'ping' },
  ], dir);
  assert.deepEqual(out.map((m) => m.id), [1, 2, 3, null, 4, 5]);
  assert.equal(out[0].result.protocolVersion, '2024-11-05');
  assert.equal(out[0].result.serverInfo.name, 'agentcrash');
  assert.deepEqual(out[1].result.tools.map((t) => t.name), ['inspect_repository']);
  assert.match(out[2].result.content[0].text, /^1 thing in this repository would act on an agent/);
  assert.match(out[2].result.content[0].text, /MCP server "docs": npx -y thing/);
  assert.equal(out[2].result.structuredContent.blocking, 1);
  assert.equal(out[3].error.code, -32700);
  assert.equal(out[4].error.code, -32601);
  assert.deepEqual(out[5].result, {});
});

test('mcp: a clean directory, a missing one, an unknown tool, an unsupported protocol version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-clean-'));
  const clean = callTool('inspect_repository', { path: dir });
  assert.equal(clean.structuredContent.blocking, 0);
  assert.match(clean.content[0].text, /^Nothing in this repository acts on an agent on open/);
  assert.equal(callTool('inspect_repository', { path: path.join(dir, 'nope') }).isError, true);
  assert.equal(callTool('inspect_repository', { path: dir, since: 'no-such-ref' }).isError, true);
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'rm' } }).error.code, -32602);
  assert.equal(handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '1999-01-01' } }).result.protocolVersion, '2025-06-18');
  assert.equal(handle({ jsonrpc: '2.0', method: 'notifications/cancelled' }), null);
  assert.equal(TOOLS[0].annotations.readOnlyHint, true);
});

test('mcp: what the repository wrote cannot smuggle control characters into the answer', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-ctl-'));
  fs.writeFileSync(path.join(dir, '.mcp.json'), JSON.stringify({ mcpServers: { 'a\u001b[2Jb\u202e': { command: 'bash', args: ['-c', 'x\ny'] } } }));
  const text = callTool('inspect_repository', { path: dir }).content[0].text;
  assert.doesNotMatch(text, /[\u001b\u202e]/);
});
