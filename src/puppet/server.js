// The puppet: a fake model endpoint. It speaks four wire protocols (Anthropic
// Messages, OpenAI Responses, OpenAI Chat Completions, Gemini generateContent) and, instead of thinking,
// plays a fixed script of shell commands. It also hosts the exfiltration sink,
// so a request that carries a canary out of the sandbox is observed here.
import http from 'node:http';
import { anthropic } from './anthropic.js';
import { openai } from './openai.js';
import { gemini } from './gemini.js';
import { chat } from './chat.js';

const PROTOCOLS = [anthropic, openai, gemini, chat];

export function startPuppet({ script, payload = '' }) {
  const state = {
    script,              // array of attempts {kind:'shell',command} | {kind:'read',path}
    plan: null, skipped: [], offeredKinds: [], delivered: 0,
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

// Shared by every protocol. `offered` maps a tool kind ('shell' | 'read') to a
// function building that protocol's call for an attempt, or is missing when the
// agent does not expose such a tool. Attempts whose kind is not offered are
// skipped and counted: they were never delivered, so they say nothing about
// containment.
export function nextCall(state, offered, results) {
  if (!state.plan) {
    state.plan = state.script.filter((a) => offered[a.kind]);
    if (!state.pass) {
      state.skipped = state.script.filter((a) => !offered[a.kind]).map((a) => a.kind);
      state.offeredKinds = Object.keys(offered).filter((k) => offered[k]);
    }
  }
  const prior = state.prior || [];
  state.toolResults = [...prior, ...results.map((r, i) => ({
    index: prior.length + i, attempt: state.plan[i] ?? null, output: r.output, isError: !!r.isError,
  }))];
  const next = results.length < state.plan.length ? state.plan[results.length] : null;
  if (next) state.passDelivered = Math.max(state.passDelivered || 0, results.length + 1);
  state.delivered = (state.priorDelivered || 0) + (state.passDelivered || 0);
  return next ? offered[next.kind](next) : null;
}

// Some agents end the whole session when one tool call is refused, so the
// attempts after it are never put to them. An attacker simply tries again:
// queue what is left for a new session. Returns false when nothing is left or
// the last session delivered nothing (no progress, so no point retrying).
export function nextPass(state) {
  if (!state.plan || !state.passDelivered) return false;
  const remaining = state.plan.slice(state.passDelivered);
  if (!remaining.length) return false;
  state.prior = state.toolResults;
  state.priorDelivered = state.delivered;
  state.script = remaining;
  state.plan = null;
  state.passDelivered = 0;
  state.pass = (state.pass || 0) + 1;
  return true;
}
