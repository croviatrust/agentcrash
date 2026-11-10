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
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
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
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
  const tools = [{ type: 'function', name: 'exec_command', parameters: { properties: { cmd: { type: 'string' } } } }];
  const r = await post(p.baseUrl, '/v1/responses', { stream: true, tools, input: [{ role: 'user', content: 'go' }] });
  assert.equal(firstCommand(r.text, 'openai'), 'echo hi');
  assert.equal(p.state.protocol, 'openai-responses');
  await p.close();
});

test('gemini: emits a functionCall for the scripted command', async () => {
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
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

test('an attack the agent offers no tool for is never delivered', async () => {
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
  const tools = [{ functionDeclarations: [{ name: 'read_file', parameters: {} }] }];
  const r = await post(p.baseUrl, '/v1beta/models/x:streamGenerateContent?alt=sse',
    { tools, contents: [{ role: 'user', parts: [{ text: 'go' }] }] });
  assert.doesNotMatch(r.text, /functionCall/);
  assert.equal(p.state.delivered, 0);
  assert.deepEqual(p.state.skipped, ['shell']);
  await p.close();
});

test('a read attempt goes through the native read tool when it is the only one offered', async () => {
  const p = await startPuppet({ script: [{ kind: 'read', path: '/h/.ssh/id' }, { kind: 'shell', command: 'cat /h/.ssh/id' }] });
  const tools = [{ functionDeclarations: [{ name: 'read_file', parameters: {} }] }];
  const r = await post(p.baseUrl, '/v1beta/models/x:streamGenerateContent?alt=sse',
    { tools, contents: [{ role: 'user', parts: [{ text: 'go' }] }] });
  assert.match(r.text, /"name":"read_file"/);
  assert.match(r.text, /"file_path":"\/h\/.ssh\/id"/);
  assert.equal(p.state.delivered, 1);
  await p.close();
});

const chatTools = [
  { type: 'function', function: { name: 'run_shell_command', parameters: { type: 'object', properties: { command: { type: 'string' }, is_background: { type: 'boolean' } }, required: ['command', 'is_background'] } } },
  { type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } } },
];

test('chat completions: streams a tool call, fills required arguments, then ends', async () => {
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
  const base = { model: 'm', stream: true, tools: chatTools };
  const r1 = await post(p.baseUrl, '/v1/chat/completions', { ...base, messages: [{ role: 'user', content: 'go' }] });
  const call = r1.text.split('\n').filter((l) => l.startsWith('data: {')).map((l) => JSON.parse(l.slice(6)))
    .flatMap((c) => c.choices[0]?.delta?.tool_calls || [])[0];
  assert.equal(call.function.name, 'run_shell_command');
  assert.deepEqual(JSON.parse(call.function.arguments), { is_background: false, command: 'echo hi' });
  assert.match(r1.text, /"finish_reason":"tool_calls"/);
  assert.match(r1.text, /data: \[DONE\]/);
  const r2 = await post(p.baseUrl, '/v1/chat/completions', { ...base, messages: [
    { role: 'user', content: 'go' }, { role: 'assistant', tool_calls: [call] },
    { role: 'tool', tool_call_id: call.id, content: 'hi' },
  ] });
  assert.match(r2.text, /"finish_reason":"stop"/);
  assert.equal(p.state.toolResults[0].output, 'hi');
  assert.equal(p.state.protocol, 'openai-chat-completions');
  await p.close();
});

test('chat completions: a request without tools does not consume the script', async () => {
  const p = await startPuppet({ script: [{ kind: 'shell', command: 'echo hi' }] });
  const r = await post(p.baseUrl, '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: 'title?' }] });
  assert.equal(JSON.parse(r.text).choices[0].finish_reason, 'stop');
  assert.equal(p.state.delivered, 0);
  await p.close();
});

test('tool resolver: finds shell and read tools by schema, whatever the vendor calls them', async () => {
  const { offeredTools } = await import('../src/puppet/tools.js');
  const o = offeredTools([
    { name: 'terminal_exec', properties: { cmd: { type: 'array' } }, required: ['cmd'] },
    { name: 'view', properties: { path: { type: 'string' }, limit: { type: 'integer' } }, required: ['path'] },
    { name: 'web_search', properties: { query: { type: 'string' } } },
  ]);
  assert.deepEqual(o.shell({ command: 'id' }), { name: 'terminal_exec', args: { cmd: ['bash', '-lc', 'id'] } });
  assert.deepEqual(o.read({ path: '/x' }), { name: 'view', args: { path: '/x' } });
  assert.deepEqual(Object.keys(offeredTools([{ name: 'web_search', properties: { query: {} } }])), []);
});

test('a session ended by a refusal leaves the remaining attempts for the next session', async () => {
  const { nextPass } = await import('../src/puppet/server.js');
  const p = await startPuppet({ script: [{ kind: 'read', path: '/a' }, { kind: 'shell', command: 'cat /a' }] });
  const base = { model: 'm', tools: chatTools };
  // Session 1: the read is delivered, the agent dies without answering.
  await post(p.baseUrl, '/v1/chat/completions', { ...base, messages: [{ role: 'user', content: 'go' }] });
  assert.equal(p.state.delivered, 1);
  assert.equal(nextPass(p.state), true);
  // Session 2: starts from the attempt that was never delivered.
  const r = await post(p.baseUrl, '/v1/chat/completions', { ...base, messages: [{ role: 'user', content: 'go' }] });
  assert.match(r.text, /cat \/a/);
  assert.equal(p.state.delivered, 2);
  assert.equal(nextPass(p.state), false);
  await p.close();
});
