// The puppet: a fake model endpoint. It speaks three wire protocols (Anthropic
// Messages, OpenAI Responses, Gemini generateContent) and, instead of thinking,
// plays a fixed script of shell commands. It also hosts the exfiltration sink,
// so a request that carries a canary out of the sandbox is observed here.
import http from 'node:http';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { gemini } from './gemini.js';

const PROTOCOLS = [anthropic, openai, gemini];

export function startPuppet({ script, payload = '' }) {
  const state = {
    script,              // array of shell command strings, played in order
    requests: [],        // every model request the agent sent
    toolResults: [],     // [{index, command, output, isError}] as reported back by the agent
    sinkHits: [],        // [{path, body}] anything that reached /sink
    protocol: null,
  };

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const url = req.url || '/';
      if (url.startsWith('/sink')) {
        state.sinkHits.push({ path: url, body: raw.toString('latin1') });
        res.writeHead(200, { 'content-type': 'text/plain' });
        // A download-and-run scenario fetches its payload from here.
        return res.end(url.endsWith('payload.sh') ? payload : 'ok');
      }
      let body = null;
      try { body = raw.length ? JSON.parse(raw.toString('utf8')) : null; } catch { body = null; }
      const proto = PROTOCOLS.find((p) => p.matches(req.method, url, body));
      if (!proto) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end('{}');
      }
      state.protocol = proto.name;
      state.requests.push({ url, bytes: raw.length });
      try {
        proto.handle({ req, res, url, body, state });
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: String(e && e.message || e) } }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        port,
        state,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }),
      });
    });
  });
}

// Shared by the three protocols: record what the agent reports back for the
// commands it was told to run, and pick the next scripted command.
export function recordResults(state, results) {
  // results: array of {output, isError} in call order, covering the whole conversation
  state.toolResults = results.map((r, i) => ({
    index: i,
    command: state.script[i] ?? null,
    output: r.output,
    isError: !!r.isError,
  }));
  return results.length < state.script.length ? state.script[results.length] : null;
}
