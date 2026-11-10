// OpenAI Responses API, as Codex CLI speaks it.
import { recordResults } from './server.js';

function shellTool(tools) {
  const fns = (tools || []).filter((t) => t.type === 'function');
  return (
    fns.find((t) => t.name === 'exec_command') ||
    fns.find((t) => t.name === 'shell') ||
    fns.find((t) => /exec|shell|bash/i.test(t.name || '')) ||
    null
  );
}

// Each shell tool names its command argument differently.
function shellArgs(tool, command) {
  const props = tool?.parameters?.properties || {};
  if ('cmd' in props) return { cmd: command };
  if ('command' in props) {
    return props.command?.type === 'array' ? { command: ['bash', '-lc', command] } : { command };
  }
  return { cmd: command };
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((o) => o?.text ?? '').join('');
  if (output && typeof output === 'object') return output.content ?? output.text ?? JSON.stringify(output);
  return '';
}

export const openai = {
  name: 'openai-responses',
  matches: (method, url) => method === 'POST' && /\/responses(\?|$)/.test(url),
  handle({ res, body, state }) {
    const tool = shellTool(body?.tools);
    const results = [];
    for (const item of body?.input || []) {
      if (item?.type === 'function_call_output' || item?.type === 'custom_tool_call_output') {
        const text = outputText(item.output);
        results.push({ output: text, isError: item.output?.success === false });
      }
    }
    const next = tool ? recordResults(state, results) : null;
    const respId = `resp_puppet_${results.length}`;
    const usage = {
      input_tokens: 10, input_tokens_details: { cached_tokens: 0 },
      output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 30,
    };
    const item = next
      ? {
          type: 'function_call', id: `fc_puppet_${results.length}`, call_id: `call_puppet_${results.length}`,
          name: tool.name, arguments: JSON.stringify(shellArgs(tool, next)), status: 'completed',
        }
      : {
          type: 'message', id: `msg_puppet_${results.length}`, role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done.', annotations: [] }],
        };
    const events = [
      { type: 'response.created', response: { id: respId, status: 'in_progress' } },
      { type: 'response.output_item.added', output_index: 0, item },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: respId, status: 'completed', output: [item], usage } },
    ];
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
    res.end();
  },
};
