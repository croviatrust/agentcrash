// OpenAI Chat Completions, the protocol most open agent CLIs speak
// (Qwen Code, opencode, Crush and anything "OpenAI-compatible").
import { nextCall } from './server.js';
import { offeredTools } from './tools.js';

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((c) => (typeof c === 'string' ? c : c?.text ?? '')).join('');
}

export const chat = {
  name: 'openai-chat-completions',
  matches: (method, url) => method === 'POST' && /\/chat\/completions(\?|$)/.test(url),
  handle({ res, body, state }) {
    const tools = (body?.tools || []).map((t) => t.function || t).map((f) => ({
      name: f.name, properties: f.parameters?.properties, required: f.parameters?.required,
    }));
    const offered = offeredTools(tools);
    const results = (body?.messages || []).filter((m) => m.role === 'tool')
      .map((m) => ({ output: textOf(m.content), isError: false }));
    // Side calls (titles, summaries) carry no tools: answer blandly, script untouched.
    const next = Object.keys(offered).length ? nextCall(state, offered, results) : null;
    const id = `chatcmpl-puppet-${results.length}`;
    const model = body?.model || 'puppet';
    const created = Math.floor(Date.now() / 1000);
    const usage = { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 };
    const call = next && {
      id: `call_puppet_${results.length}`, type: 'function',
      function: { name: next.name, arguments: JSON.stringify(next.args) },
    };
    const finish = call ? 'tool_calls' : 'stop';
    if (!body?.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      const message = call ? { role: 'assistant', content: null, tool_calls: [call] } : { role: 'assistant', content: 'Done.' };
      return res.end(JSON.stringify({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message, finish_reason: finish }], usage }));
    }
    const chunk = (delta, finish_reason = null, extra = {}) =>
      ({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason }], ...extra });
    const chunks = [chunk({ role: 'assistant', content: '' })];
    if (call) chunks.push(chunk({ tool_calls: [{ index: 0, ...call }] }));
    else chunks.push(chunk({ content: 'Done.' }));
    chunks.push(chunk({}, finish));
    chunks.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage });
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  },
};
