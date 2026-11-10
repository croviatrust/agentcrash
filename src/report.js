// Rendering: a colored terminal matrix, a shareable self-contained HTML page.
import { scenarios } from '../scenarios/index.js';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };
const EXPOSED = 'EXPOSED', CONTAINED = 'CONTAINED', ERROR = 'ERROR';

function cell(v) {
  if (v.verdict === EXPOSED) return `${C.red}✗ EXPOSED${C.reset}`;
  if (v.verdict === CONTAINED) return `${C.green}✓ contained${C.reset}`;
  return `${C.yellow}? not tested${C.reset}`;
}

// results: array of run objects. Group into a scenario × (agent/mode) grid.
export function renderTerminal(results, meta = {}) {
  const cols = [...new Map(results.map((r) => [`${r.agent}/${r.mode}`, { agent: r.agent, mode: r.mode }])).values()];
  const scenarioOrder = [...new Set(results.map((r) => r.scenario))];
  const titles = Object.fromEntries(results.map((r) => [r.scenario, r.title]));
  const key = (a, m, s) => results.find((r) => r.agent === a && r.mode === m && r.scenario === s);

  const lines = [];
  lines.push('');
  lines.push(`${C.bold}agentcrash — coding-agent security crash test${C.reset}`);
  if (meta.versions) lines.push(`${C.dim}${meta.versions}${C.reset}`);
  lines.push('');
  const w = 44;
  const cw = Math.max(14, ...cols.map((c) => `${c.agent}/${c.mode}`.length)) + 2;
  const head = 'scenario'.padEnd(w) + cols.map((c) => `${c.agent}/${c.mode}`.padEnd(cw)).join('');
  lines.push(C.bold + head + C.reset);
  lines.push(C.dim + '-'.repeat(head.length) + C.reset);
  for (const s of scenarioOrder) {
    let row = (titles[s] || s).slice(0, w - 1).padEnd(w);
    for (const c of cols) {
      const v = key(c.agent, c.mode, s);
      const txt = v ? cell(v) : `${C.dim}-${C.reset}`;
      // pad by visible length (strip ANSI)
      const vis = txt.replace(/\x1b\[[0-9;]*m/g, '');
      row += txt + ' '.repeat(Math.max(0, cw - vis.length));
    }
    lines.push(row);
  }
  lines.push('');
  const n = (v) => results.filter((r) => r.verdict === v).length;
  const untested = results.length - n(EXPOSED) - n(CONTAINED);
  lines.push(`${results.length} runs · ${C.red}${n(EXPOSED)} exposed${C.reset} · ${C.green}${n(CONTAINED)} contained${C.reset} · ${C.yellow}${untested} not tested${C.reset}`);
  if (untested) lines.push(`${C.dim}not tested = the agent offered no tool able to carry the attack in that mode, or never answered; it is not a containment.${C.reset}`);
  lines.push('');
  return lines.join('\n');
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function renderHtml(results, meta = {}) {
  const cols = [...new Map(results.map((r) => [`${r.agent}/${r.mode}`, { agent: r.agent, mode: r.mode }])).values()];
  const scenarioOrder = [...new Set(results.map((r) => r.scenario))];
  const titles = Object.fromEntries(results.map((r) => [r.scenario, r.title]));
  const harms = Object.fromEntries(results.map((r) => [r.scenario, r.harm]));
  const key = (a, m, s) => results.find((r) => r.agent === a && r.mode === m && r.scenario === s);
  const exposed = results.filter((r) => r.verdict === EXPOSED).length;
  const contained = results.filter((r) => r.verdict === CONTAINED).length;
  const untested = results.length - exposed - contained;

  const th = cols.map((c) => `<th><span class="ag">${esc(c.agent)}</span><span class="md">${esc(c.mode)}</span></th>`).join('');
  const rows = scenarioOrder.map((s) => {
    const tds = cols.map((c) => {
      const v = key(c.agent, c.mode, s);
      if (!v) return '<td class="na">—</td>';
      const cls = v.verdict === EXPOSED ? 'exp' : v.verdict === CONTAINED ? 'con' : 'na';
      const label = v.verdict === EXPOSED ? 'EXPOSED' : v.verdict === CONTAINED ? 'contained' : 'not tested';
      return `<td class="${cls}" title="${esc((v.evidence || []).map((e) => `[${e.kind}] ${e.output}`).join(' | ').slice(0, 500))}">${label}</td>`;
    }).join('');
    return `<tr><td class="sc"><b>${esc(titles[s] || s)}</b><span class="harm">${esc(harms[s] || '')}</span></td>${tds}</tr>`;
  }).join('\n');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>agentcrash — coding-agent security crash test</title>
<style>
:root{--bg:#0b0e14;--card:#121722;--line:#222a39;--txt:#e6edf3;--dim:#8b98a9;--exp:#ff5c5c;--con:#2ecc71}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1000px;margin:0 auto;padding:40px 20px}
h1{font-size:28px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 24px}
.stat{display:flex;gap:24px;margin:0 0 24px;flex-wrap:wrap}
.stat div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px}
.stat b{font-size:22px;display:block}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:center;border-bottom:1px solid var(--line);font-size:13px}
th{background:#0e131d;position:sticky;top:0}.ag{display:block;font-weight:700}.md{display:block;color:var(--dim);font-size:11px;font-weight:400}
td.sc{text-align:left}td.sc b{display:block}.harm{color:var(--dim);font-size:11px;letter-spacing:.04em}
td.exp{color:var(--exp);font-weight:700}td.con{color:var(--con)}td.na{color:var(--dim)}
.foot{color:var(--dim);margin-top:20px;font-size:13px}.foot code{background:#0e131d;padding:2px 6px;border-radius:5px}
</style></head><body><div class="wrap">
<h1>agentcrash</h1>
<p class="sub">What a hijacked model can make your coding agent do — judged by real filesystem &amp; network effects, not by what the agent said.</p>
<div class="stat">
<div><b style="color:var(--exp)">${exposed}</b><span class="dim">exposed</span></div>
<div><b style="color:var(--con)">${contained}</b><span class="dim">contained</span></div>
<div><b style="color:var(--dim)">${untested}</b><span class="dim">not tested</span></div>
<div><b>${results.length}</b><span class="dim">runs</span></div>
</div>
<table><thead><tr><th class="sc" style="text-align:left">scenario</th>${th}</tr></thead><tbody>
${rows}
</tbody></table>
<p class="foot">${esc(meta.versions || '')}<br>Deterministic puppet model · synthetic canary secrets · isolated sandboxes · &ldquo;not tested&rdquo; means the agent offered no tool able to carry that attack in that mode: it is not a containment. Generated ${esc(meta.date || new Date().toISOString())}. Reproduce: <code>npx agentcrash</code></p>
</div></body></html>`;
}
