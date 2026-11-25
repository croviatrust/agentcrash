// Rendering: a colored terminal matrix, a shareable self-contained HTML page.
import { scenarios } from '../scenarios/index.js';
import { iconSvg, markSvg } from './mark.js';

const C = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', dim: '\x1b[2m', bold: '\x1b[1m' };
const EXPOSED = 'EXPOSED', CONTAINED = 'CONTAINED', ERROR = 'ERROR';

function cell(v) {
  if (v.verdict === EXPOSED) return `${C.red}✗ EXPOSED${C.reset}`;
  if (v.verdict === CONTAINED) return `${C.green}✓ contained${C.reset}`;
  return `${C.yellow}? not tested${C.reset}`;
}

// results: array of run objects. One scenario × mode grid per agent, so the
// output stays readable however many agents are installed.
export function renderTerminal(results, meta = {}) {
  const agents = [...new Set(results.map((r) => r.agent))];
  const scenarioOrder = [...new Set(results.map((r) => r.scenario))];
  const titles = Object.fromEntries(results.map((r) => [r.scenario, r.title]));
  const key = (a, m, s) => results.find((r) => r.agent === a && r.mode === m && r.scenario === s);

  const lines = [];
  lines.push('');
  lines.push(`${C.bold}agentcrash — coding-agent security crash test${C.reset}`);
  if (meta.versions) lines.push(`${C.dim}${meta.versions}${C.reset}`);
  const w = 44;
  for (const agent of agents) {
    const modes = [...new Set(results.filter((r) => r.agent === agent).map((r) => r.mode))];
    const cw = Math.max(14, ...modes.map((m) => m.length)) + 2;
    const head = agent.padEnd(w) + modes.map((m) => m.padEnd(cw)).join('');
    lines.push('');
    lines.push(C.bold + head + C.reset);
    lines.push(C.dim + '-'.repeat(head.length) + C.reset);
    for (const s of scenarioOrder) {
      let row = (titles[s] || s).slice(0, w - 1).padEnd(w);
      for (const m of modes) {
        const v = key(agent, m, s);
        const txt = v ? cell(v) : `${C.dim}-${C.reset}`;
        // pad by visible length (strip ANSI)
        const vis = txt.replace(/\x1b\[[0-9;]*m/g, '');
        row += txt + ' '.repeat(Math.max(0, cw - vis.length));
      }
      lines.push(row);
    }
  }
  lines.push('');
  const n = (v) => results.filter((r) => r.verdict === v).length;
  const untested = results.length - n(EXPOSED) - n(CONTAINED);
  lines.push(`${results.length} runs · ${C.red}${n(EXPOSED)} exposed${C.reset} · ${C.green}${n(CONTAINED)} contained${C.reset} · ${C.yellow}${untested} not tested${C.reset}`);
  if (untested) lines.push(`${C.dim}not tested = ${untestedNote(results)}; it is not a containment.${C.reset}`);
  const cs = cageSummary(results);
  if (cs) {
    lines.push('');
    lines.push(`${C.bold}same attacks, same agents:${C.reset} bare ${C.red}${cs.bare} exposed${C.reset} → in the cage ${cs.caged ? C.red : cs.unmeasured ? C.yellow : C.green}${cs.caged} exposed${C.reset}${cs.unmeasured ? ` · ${C.yellow}${cs.unmeasured} not measured${C.reset}` : ''}`);
    if (cs.caged) lines.push(`${C.dim}${cs.note}${C.reset}`);
    if (cs.unmeasured) lines.push(`${C.yellow}${cs.unmeasuredNote}${C.reset}`);
  }
  lines.push('');
  return lines.join('\n');
}

// With --cage every test ran twice. What is left exposed inside the cage is
// damage to the workspace, which the cage leaves writable and records first.
// A test that had a verdict bare and has none in the cage was never put to the
// agent there (it did not start, or did not reach the model): that is counted
// and said, because "0 exposed" over tests that did not run is not a result.
const tested = (r) => r?.verdict === EXPOSED || r?.verdict === CONTAINED;
const cellOf = (r) => `${r.agent}\u0000${String(r.mode).replace(/ \+ cage$/, '')}\u0000${r.scenario}`;
export function cageSummary(results) {
  const inCage = results.filter((r) => r.caged);
  if (!inCage.length) return null;
  const bare = new Map(results.filter((r) => !r.caged).map((r) => [cellOf(r), r]));
  const lost = inCage.filter((r) => !tested(r) && tested(bare.get(cellOf(r))));
  const left = inCage.filter((r) => r.verdict === EXPOSED);
  const undone = left.filter((r) => r.undo_restored).length;
  const what = [...new Set(left.map((r) => r.title || r.scenario))].join('; ');
  const why = lost.map((r) => String(r.stderr_tail || '').trim().split('\n').pop()).find(Boolean) || '';
  return {
    bare: results.filter((r) => !r.caged && r.verdict === EXPOSED).length,
    caged: left.length,
    undone,
    unmeasured: lost.length,
    unmeasuredNote: lost.length
      ? `not measured in the cage: ${lost.length} of ${inCage.length} tests had a verdict bare and none in the cage, because the agent did not run there${why ? ` (${why})` : ''}. This says nothing about the cage.`
      : '',
    note: left.length ? `still exposed in the cage: ${what}.${left.some((r) => 'undo_restored' in r) ? ` agentcrash cage --undo put the files back in ${undone} of ${left.length}.` : ''}` : '',
  };
}

// Repo-mode runs are judged on project configuration, not on tool calls.
const isRepo = (results) => results.some((r) => r.kind === 'repo');
const untestedNote = (results) => (isRepo(results)
  ? 'the agent has no project-config surface for that vector, or never started'
  : 'the agent offered no tool able to carry the attack in that mode, or never answered');

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
  const cs = cageSummary(results);

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
<link rel="icon" type="image/svg+xml" href="data:image/svg+xml,${encodeURIComponent(iconSvg().trim())}">
<style>
:root{--bg:#0b0e14;--card:#121722;--line:#222a39;--txt:#e6edf3;--dim:#8b98a9;--exp:#ff5c5c;--con:#2ecc71}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--txt);font:15px/1.5 ui-sans-serif,system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
.wrap{max-width:1500px;margin:0 auto;padding:40px 20px}
.scroll{overflow-x:auto}
h1{display:flex;align-items:center;font:700 28px/1.2 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;letter-spacing:-.02em;margin:0 0 6px}h1 span{font-weight:400;color:#b9b6ae}h1 svg{flex:none;margin-right:12px}.sub{color:var(--dim);margin:0 0 24px}
.stat{display:flex;gap:24px;margin:0 0 24px;flex-wrap:wrap}
.stat div{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px}
.stat b{font-size:22px;display:block}
table{width:100%;border-collapse:collapse;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
th,td{padding:10px 12px;text-align:center;border-bottom:1px solid var(--line);font-size:13px}
th{background:#0e131d;position:sticky;top:0}.ag{display:block;font-weight:700}.md{display:block;color:var(--dim);font-size:11px;font-weight:400}
td.sc{text-align:left}td.sc b{display:block}.harm{color:var(--dim);font-size:11px;letter-spacing:.04em}
td.exp{color:var(--exp);font-weight:700}td.con{color:var(--con)}td.na{color:var(--dim)}
.cage{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:12px 18px;margin:0 0 24px}
.foot{color:var(--dim);margin-top:20px;font-size:13px}.foot a{color:inherit}
</style></head><body><div class="wrap">
<h1>${markSvg({ attrs: ' width="30" height="30" aria-hidden="true"' })}<span>agent</span>crash</h1>
<p class="sub">${isRepo(results)
  ? 'What a repository you cloned can make your coding agent do, with an honest model — judged by real filesystem &amp; network effects.'
  : 'What a hijacked model can make your coding agent do — judged by real filesystem &amp; network effects, not by what the agent said.'}</p>
<div class="stat">
<div><b style="color:var(--exp)">${exposed}</b><span class="dim">exposed</span></div>
<div><b style="color:var(--con)">${contained}</b><span class="dim">contained</span></div>
<div><b style="color:var(--dim)">${untested}</b><span class="dim">not tested</span></div>
<div><b>${results.length}</b><span class="dim">runs</span></div>
</div>
${cs ? `<p class="cage"><b>Same attacks, same agents:</b> bare <b style="color:var(--exp)">${cs.bare} exposed</b> → inside <code>agentcrash cage</code> <b style="color:${cs.caged ? 'var(--exp)' : cs.unmeasured ? 'var(--dim)' : 'var(--con)'}">${cs.caged} exposed</b>.${cs.caged ? ` ${esc(cs.note[0].toUpperCase() + cs.note.slice(1))}` : ''}${cs.unmeasured ? ` <b>${esc(cs.unmeasuredNote[0].toUpperCase() + cs.unmeasuredNote.slice(1))}</b>` : ''}</p>` : ''}
<div class="scroll"><table><thead><tr><th class="sc" style="text-align:left">scenario</th>${th}</tr></thead><tbody>
${rows}
</tbody></table></div>
<p class="foot">${esc(meta.versions || '')}<br>Deterministic puppet model · synthetic canary secrets · isolated sandboxes · &ldquo;not tested&rdquo; means ${untestedNote(results)}; it is not a containment. Generated ${esc(meta.date || new Date().toISOString())}. Reproduce: <a href="https://github.com/croviatrust/agentcrash">github.com/croviatrust/agentcrash</a></p>
</div></body></html>`;
}
