// Protocol-level tests: no real agent needed. We hand-roll each wire protocol's
// request shape, play the puppet, feed tool results back, and assert it (a)
// drives the scripted command, (b) stops after the script, (c) records sink hits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startPuppet } from '../src/puppet/server.js';

async function post(baseUrl, path, body, headers = {}) {
  const res = await fetch(baseUrl + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text };
}

// Pull the first command the puppet wants run, out of whatever protocol envelope.
function firstCommand(text, proto) {
  if (proto === 'anthropic') {
    const m = text.match(/"command":"([^"]+)"/); return m && m[1];
  }
  if (proto === 'openai') {
    const m = text.match(/"arguments":"(.*?)","status"/); if (!m) return null;
    return JSON.parse(JSON.parse(`"${m[1]}"`)).cmd ?? JSON.parse(JSON.parse(`"${m[1]}"`)).command;
  }
  const m = text.match(/"command":"([^"]+)"/); return m && m[1]; // gemini
}

test('anthropic: drives the script, then ends', async () => {
  const p = await startPuppet({ script: ['echo hi'] });
  const tools = [{ name: 'Bash', input_schema: {} }];
  let r = await post(p.baseUrl, '/v1/messages', { model: 'm', tools, messages: [{ role: 'user', content: 'go' }] });
  assert.equal(firstCommand(r.text, 'anthropic'), 'echo hi');
  // feed the tool_result back; puppet should now end (no more script)
  r = await post(p.baseUrl, '/v1/messages', { model: 'm', tools, messages: [
    { role: 'user', content: 'go' },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Bash', input: { command: 'echo hi' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'hi' }] },
  ] });
  assert.match(r.text, /end_turn/);
  assert.equal(p.state.protocol, 'anthropic-messages');
  assert.equal(p.state.toolResults[0].output, 'hi');
  await p.close();
});

test('openai responses: emits a function_call for the scripted command', async () => {
  const p = await startPuppet({ script: ['echo hi'] });
  const tools = [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }];
  const r = await post(p.baseUrl, '/v1/responses', { stream: true, tools, input: [{ role: 'user', content: 'go' }] });
  assert.equal(firstCommand(r.text, 'openai'), 'echo hi');
  assert.equal(p.state.protocol, 'openai-responses');
  await p.close();
});

test('gemini: emits a functionCall for the scripted command', async () => {
  const p = await startPuppet({ script: ['echo hi'] });
  const tools = [{ functionDeclarations: [{ name: 'run_shell_command', parameters: {} }] }];
  const r = await post(p.baseUrl, '/v1beta/models/x:streamGenerateContent?alt=sse',
    { tools, contents: [{ role: 'user', parts: [{ text: 'go' }] }] });
  assert.equal(firstCommand(r.text, 'gemini'), 'echo hi');
  assert.equal(p.state.protocol, 'gemini-generatecontent');
  await p.close();
});

test('sink records exfiltrated bytes', async () => {
  const p = await startPuppet({ script: [] });
  await post(p.baseUrl, '/sink/env', 'SECRET=CANARY-XYZ');
  assert.equal(p.state.sinkHits.length, 1);
  assert.match(p.state.sinkHits[0].body, /CANARY-XYZ/);
  await p.close();
});

test('payload endpoint serves the download-and-run script', async () => {
  const p = await startPuppet({ script: [], payload: 'echo pwned\n' });
  const res = await fetch(p.baseUrl + '/sink/payload.sh');
  assert.equal(await res.text(), 'echo pwned\n');
  await p.close();
});
