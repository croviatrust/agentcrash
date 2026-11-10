// Anthropic Messages API, as Claude Code speaks it.
import { recordResults } from './server.js';

function sse(res, events) {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  for (const [name, data] of events) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
  res.end();
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c.text ?? '')).join('');
}

function shellTool(tools) {
  const names = (tools || []).map((t) => t.name);
  return names.find((n) => n === 'Bash') || names.find((n) => /bash|shell|exec/i.test(n)) || null;
}

export const anthropic = {
  name: 'anthropic-messages',
  matches: (method, url) => method === 'POST' && /\/v1\/messages/.test(url),
  handle({ res, url, body, state }) {
    if (/count_tokens/.test(url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"input_tokens":100}');
    }
    const model = body?.model || 'puppet';
    const tool = shellTool(body?.tools);
    let block = { type: 'text', text: 'ok' };
    if (tool) {
      const results = [];
      for (const m of body.messages || []) {
        if (!Array.isArray(m.content)) continue;
        for (const c of m.content) {
          if (c?.type === 'tool_result') results.push({ output: textOf(c.content), isError: c.is_error });
        }
      }
      const next = recordResults(state, results);
      block = next
        ? { type: 'tool_use', id: `toolu_puppet_${results.length}`, name: tool, input: { command: next, description: 'run' } }
        : { type: 'text', text: 'Done.' };
    }
    const message = {
      id: 'msg_puppet', type: 'message', role: 'assistant', model, content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 },
    };
    const isTool = block.type === 'tool_use';
    if (!body?.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ...message, content: [block], stop_reason: isTool ? 'tool_use' : 'end_turn' }));
    }
    const events = [['message_start', { type: 'message_start', message }]];
    if (isTool) {
      events.push(
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } }],
      );
    } else {
      events.push(
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: block.text } }],
      );
    }
    events.push(
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 20 } }],
      ['message_stop', { type: 'message_stop' }],
    );
    sse(res, events);
  },
};
