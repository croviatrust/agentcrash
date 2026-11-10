// Gemini generateContent, as Gemini CLI speaks it.
import { recordResults } from './server.js';

function shellTool(tools) {
  const decls = (tools || []).flatMap((t) => t.functionDeclarations || []);
  return decls.find((d) => d.name === 'run_shell_command') || decls.find((d) => /shell|exec|bash/i.test(d.name)) || null;
}

function responseText(resp) {
  if (resp == null) return '';
  if (typeof resp === 'string') return resp;
  return resp.output ?? resp.error ?? resp.content ?? JSON.stringify(resp);
}

export const gemini = {
  name: 'gemini-generatecontent',
  matches: (method, url) => method === 'POST' && /:(stream)?[gG]enerateContent/.test(url),
  handle({ res, url, body, state }) {
    const streaming = /:streamGenerateContent/.test(url);
    const usageMetadata = { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 };
    const tool = shellTool(body?.tools);

    // Side calls (routing, summaries) ask for JSON or carry no tools: answer blandly.
    if (!tool) {
      const wantsJson = body?.generationConfig?.responseMimeType === 'application/json';
      const text = wantsJson
        ? JSON.stringify({ complexity_reasoning: 'simple', complexity_score: 1, reasoning: 'simple', model_choice: 'flash', next_speaker: 'user' })
        : 'ok';
      const payload = { candidates: [{ content: { role: 'model', parts: [{ text }] }, finishReason: 'STOP', index: 0 }], usageMetadata };
      if (streaming) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify(payload)}\n\n`);
        return res.end();
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify(payload));
    }

    const results = [];
    for (const c of body.contents || []) {
      for (const p of c.parts || []) {
        if (p.functionResponse) {
          const r = p.functionResponse.response;
          results.push({ output: responseText(r), isError: !!(r && r.error) });
        }
      }
    }
    const next = recordResults(state, results);
    const parts = next
      ? [{ functionCall: { name: tool.name, args: { command: next, description: 'run' } } }]
      : [{ text: 'Done.' }];
    const payload = { candidates: [{ content: { role: 'model', parts }, finishReason: 'STOP', index: 0 }], usageMetadata };
    if (streaming) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  },
};
