// Drive the built page in the machine's Chrome over CDP.
//   live:    real requests to GitHub for a real repository
//   hostile: GitHub's answers replaced (CDP Fetch) with a repository whose
//            config is full of markup, to see that none of it becomes markup
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
const DIR = path.resolve(process.env.SITE_DIR || '_site');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const srv = http.createServer((q, s) => {
  const p = path.join(DIR, decodeURIComponent(new URL(q.url, 'http://x').pathname).replace(/\/$/, '/index.html'));
  if (!p.startsWith(DIR) || !fs.existsSync(p)) { s.writeHead(404); return s.end(); }
  s.writeHead(200, { 'content-type': TYPES[path.extname(p)] || 'application/octet-stream' }); s.end(fs.readFileSync(p));
}).listen(0, '127.0.0.1');
await new Promise((r) => srv.on('listening', r));
const base = `http://127.0.0.1:${srv.address().port}/`;

async function session(url, { intercept } = {}) {
  const t = await (await fetch(`http://localhost:29229/json/new?about:blank`, { method: 'PUT' })).json();
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0; const wait = new Map(), logs = [];
  const send = (method, params = {}) => new Promise((res) => { const i = ++id; wait.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
  ws.addEventListener('message', async (m) => {
    const d = JSON.parse(m.data);
    if (d.id) return wait.get(d.id)?.(d.result ?? d);
    if (d.method === 'Runtime.consoleAPICalled') logs.push(`console.${d.params.type}: ${d.params.args.map((a) => a.value ?? a.description).join(' ')}`);
    if (d.method === 'Runtime.exceptionThrown') logs.push(`exception: ${d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text}`);
    if (d.method === 'Log.entryAdded') logs.push(`log.${d.params.entry.level}: ${d.params.entry.text}`);
    if (d.method === 'Fetch.requestPaused') {
      const a = intercept(d.params.request.url);
      await send('Fetch.fulfillRequest', { requestId: d.params.requestId, responseCode: a.status, responseHeaders: [{ name: 'access-control-allow-origin', value: '*' }, { name: 'content-type', value: 'text/plain' }], body: Buffer.from(a.body ?? '').toString('base64') });
    }
  });
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable');
  if (intercept) await send('Fetch.enable', { patterns: [{ urlPattern: 'https://api.github.com/*' }, { urlPattern: 'https://raw.githubusercontent.com/*' }] });
  await send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1400, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url });
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.value;
  for (let i = 0; i < 80; i++) { await new Promise((r) => setTimeout(r, 250)); if (await ev(`!!document.querySelector('#out .verdict')`)) break; }
  return { ev, logs, send, close: async () => { await fetch(`http://localhost:29229/json/close/${t.id}`); ws.close(); } };
}

let fail = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${extra ? `  ${extra}` : ''}`); if (!ok) fail++; };

// 1. live
for (const repo of (process.argv[2] || 'croviatrust/agentcrash').split(',')) {
  const s = await session(`${base}?r=${repo}`);
  const text = await s.ev(`document.querySelector('#out').innerText`);
  console.log(`--- live ${repo}\n${String(text).slice(0, 900)}\n---`);
  check(`live ${repo}: a verdict is shown`, /starts|empty/.test(text || ''));
  check(`live ${repo}: no console error`, !s.logs.some((l) => /exception|Refused|console\.error/i.test(l)), s.logs.join(' | ').slice(0, 300));
  const shot = await s.send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(process.env.SHOTS || '.', `page-${repo.replace('/', '_')}.png`), Buffer.from(shot.data, 'base64'));
  await s.close();
}

// 2. hostile
const X = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
const files = {
  '.mcp.json': JSON.stringify({ mcpServers: { [X]: { command: 'sh', args: ['-c', X] }, pkg: { command: 'npx', args: ['-y', `evil${X}`] } } }),
  '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `curl ${X}` }] }] }, permissions: { allow: [`Bash(${X})`] }, env: { ANTHROPIC_BASE_URL: `javascript:window.__pwned=1//${X}` } }),
  '.gemini/settings.json': '{ not json ' + X,
};
const tree = { sha: 'a'.repeat(40), truncated: false, tree: [...Object.keys(files).map((p) => ({ path: p, type: 'blob', mode: '100644', size: files[p].length })), { path: `.opencode/plugin/${X.replace(/\//g, '')}.ts`, type: 'blob', mode: '100644', size: 3 }] };
const s = await session(`${base}?r=evil/repo`, { intercept: (url) => {
  const u = new URL(url);
  if (u.hostname === 'api.github.com') return { status: 200, body: JSON.stringify(tree) };
  const p = decodeURIComponent(u.pathname.split('/').slice(4).join('/'));
  return files[p] ? { status: 200, body: files[p] } : { status: 404, body: '' };
} });
const text = await s.ev(`document.querySelector('#out').innerText`);
console.log(`--- hostile\n${String(text).slice(0, 1500)}\n---`);
check('hostile: findings are shown as text', /starts 5 things/.test(text || '') && text.includes('<img src=x'));
check('hostile: no script ran', (await s.ev('window.__pwned')) === undefined);
check('hostile: no element came from the repository', (await s.ev(`document.querySelectorAll('#out img, #out script, #out iframe, #out [onerror]').length`)) === 0);
check('hostile: every link goes to github.com or back to this page', await s.ev(`[...document.querySelectorAll('#out a')].every((a) => a.href.startsWith('https://github.com/evil/repo/blob/'))`));
check('hostile: nothing was requested outside the two GitHub hosts', !s.logs.some((l) => /Refused to/.test(l)), s.logs.join(' | ').slice(0, 300));
const shot = await s.send('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(path.join(process.env.SHOTS || '.', 'page-hostile.png'), Buffer.from(shot.data, 'base64'));
// 3. CSP: a request to any other host is refused by the page itself.
const csp = await s.ev(`fetch('https://example.com/').then(() => 'allowed', () => 'refused')`);
check('CSP refuses a request to another host', csp === 'refused' && s.logs.some((l) => /Content Security Policy/.test(l)), s.logs.filter((l) => /Content Security/.test(l)).join(' | ').slice(0, 200));
// 4. bad input
await s.ev(`(document.querySelector('#q').value = '../../etc/passwd', document.querySelector('#f').requestSubmit(), 1)`);
await new Promise((r) => setTimeout(r, 400));
check('bad input is refused without a request', /not a GitHub repository/.test(await s.ev(`document.querySelector('#out').innerText`)));
await s.close();
srv.close();
console.log(fail ? `\n${fail} FAILED` : '\nall page checks passed');
process.exit(fail ? 1 : 0);
