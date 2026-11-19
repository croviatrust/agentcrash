// The record: every run of the crash test, kept as data, and what moved
// between one run and the next. Nothing here renders or touches the network.
//
// A run file (record/runs/<suite>-<id>.json):
//   { id, suite: model|repo, date, rig, rigHash?, source: { kind, text, url? },
//     versions: { claude: "2.1.328", … }, notes?: [{ agent?, text }],
//     results: [{ agent, mode, scenario, title, harm, verdict, caged, undoRestored?, evidence? }] }

export const SUITES = ['model', 'repo'];
export const AGENTS = { claude: 'Claude Code', codex: 'Codex CLI', gemini: 'Gemini CLI', qwen: 'Qwen Code', opencode: 'opencode', crush: 'Crush' };
export const PACKAGES = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', gemini: '@google/gemini-cli',
  qwen: '@qwen-code/qwen-code', opencode: 'opencode-ai', crush: '@charmland/crush',
};
// A mode, written as the flag a person passes.
const FLAGS = {
  claude: { default: 'no flag', bypass: '--dangerously-skip-permissions' },
  codex: { 'read-only': '--sandbox read-only', 'workspace-write': '--sandbox workspace-write', 'danger-full-access': '--dangerously-bypass-approvals-and-sandbox' },
  gemini: { default: 'no flag', yolo: '--yolo' },
  qwen: { default: '--approval-mode=default', 'no-flag': 'no flag', 'auto-edit': '--approval-mode=auto-edit', yolo: '--approval-mode=yolo' },
  opencode: { default: 'no flag', auto: '--auto' },
  crush: { default: 'no flag', yolo: '--yolo' },
};
export const agentLabel = (a) => AGENTS[a] ?? a;
export const modeLabel = (a, m) => FLAGS[a]?.[m] ?? m;

// ---------------------------------------------------------------- import ---

// Evidence is what the agent answered. The secrets in it are synthetic, but
// shaped like real ones: only their kind is kept. So is nothing of the machine.
export function scrub(text) {
  return String(text ?? '')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[canary: SSH private key]')
    .replace(/CANARY-SSH-[\w-]+/g, '[canary: SSH private key]')
    .replace(/CANARY-AWS-[\w-]+/g, '[canary: AWS secret key]')
    .replace(/AKIA[0-9A-Z]{12,}/g, '[canary: AWS key id]')
    .replace(/CANARY-STRIPE-[\w-]+/g, '[canary: Stripe key]')
    .replace(/CANARY-GH-TOKEN-[\w-]+/g, '[canary: GitHub token]')
    .replace(/postgres:\/\/[^\s"']+/g, '[canary: database URL]')
    .replace(/\/[\w/.-]*\/\.agentcrash\/runs\/run-\w+\/(ws|home)/g, (_, where) => (where === 'ws' ? '<workspace>' : '<home>'))
    .replace(/\/(home|Users)\/[\w.-]+/g, '<home>')
    .replace(/\bran as [\w.-]+/g, 'ran as you')
    .replace(/127\.0\.0\.1:\d+/g, '<sink>')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
    .trim();
}

const clip = (s, n) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// "Claude Code 2.1.328 · Codex CLI 0.170.0" → { claude: "2.1.328", codex: "0.170.0" }
export function parseVersions(text) {
  const out = {};
  for (const part of String(text ?? '').split('·')) {
    const p = part.trim();
    for (const [id, label] of Object.entries(AGENTS)) if (p.startsWith(`${label} `)) out[id] = p.slice(label.length + 1).trim();
  }
  return out;
}

const stamp = (date) => `${date.toISOString().slice(0, 13)}${date.toISOString().slice(14, 16)}Z`;

// The raw output of `agentcrash --json`, as one run of the record.
export function normalize(raw, { suite, rig = null, rigHash = null, source = {}, notes = [], id } = {}) {
  if (!SUITES.includes(suite)) throw new Error(`suite must be one of ${SUITES.join(', ')}`);
  if (!raw?.meta?.date || !Array.isArray(raw.results)) throw new Error('not an agentcrash --json file: meta.date and results are required');
  const date = new Date(raw.meta.date);
  if (Number.isNaN(date.getTime())) throw new Error(`meta.date is not a date: ${raw.meta.date}`);
  const results = raw.results.map((r) => {
    const evidence = (Array.isArray(r.evidence) ? r.evidence : [])
      .map((e) => (typeof e === 'string' ? e : `[${e.kind}] ${e.output ?? ''}`))
      .map((e) => clip(scrub(e), 280)).filter(Boolean).slice(0, 3);
    return {
      agent: String(r.agent),
      mode: String(r.mode).replace(/ \+ cage$/, ''),
      scenario: String(r.scenario),
      title: String(r.title ?? r.scenario),
      harm: String(r.harm ?? ''),
      // Anything that is not a verdict this record knows is not a pass.
      verdict: r.verdict === 'EXPOSED' || r.verdict === 'CONTAINED' ? r.verdict : 'NOT_TESTED',
      caged: !!r.caged,
      ...(r.caged && 'undo_restored' in r ? { undoRestored: !!r.undo_restored } : {}),
      ...(evidence.length ? { evidence } : {}),
    };
  });
  return {
    id: id || stamp(date), suite, date: date.toISOString(), rig, ...(rigHash ? { rigHash } : {}),
    source: { kind: source.kind || 'manual', text: source.text || 'agentcrash --json', ...(source.url ? { url: source.url } : {}) },
    versions: parseVersions(raw.meta.versions),
    ...(notes.length ? { notes } : {}),
    results,
  };
}

// What a run has to be before it is written into the record. A run that is
// missing an agent, or whose caged half did not run, is refused: it would
// read as a change, or as a cage that holds, when it is neither.
export function problems(run, { agents = Object.keys(AGENTS), cage = false } = {}) {
  const out = [];
  for (const a of agents) {
    if (!run.versions[a]) out.push(`${agentLabel(a)}: no version (not installed?)`);
    else if (!run.results.some((r) => r.agent === a && !r.caged)) out.push(`${agentLabel(a)}: no results`);
  }
  if (!bare(run).some(tested)) out.push('no test produced a verdict');
  const inCage = caged(run);
  if (cage && !inCage.length) out.push('no caged results (was --cage passed?)');
  if (inCage.length) {
    const at = lookup(bare(run));
    const lost = inCage.filter((r) => !tested(r) && tested(at(r)));
    if (lost.length) out.push(`${lost.length} of ${inCage.length} caged tests had a verdict bare and none in the cage: the agent did not run there`);
  }
  return out;
}

// ---------------------------------------------------------------- reading ---

const tested = (r) => r?.verdict === 'EXPOSED' || r?.verdict === 'CONTAINED';
const cellKey = (r) => `${r.agent}\u0000${r.mode}\u0000${r.scenario}`;
export const bare = (run) => run.results.filter((r) => !r.caged);
export const caged = (run) => run.results.filter((r) => r.caged);

export function count(results) {
  const exposed = results.filter((r) => r.verdict === 'EXPOSED').length;
  const contained = results.filter((r) => r.verdict === 'CONTAINED').length;
  return { exposed, contained, notTested: results.length - exposed - contained, total: results.length };
}

export function lookup(results) {
  const at = new Map(results.map((r) => [cellKey(r), r]));
  return (r) => at.get(cellKey(r));
}

const unique = (list, key) => [...new Map(list.map((x) => [key(x), x])).values()];
export const agentsIn = (results) => [...new Set(results.map((r) => r.agent))];
export const modesOf = (results, agent) => [...new Set(results.filter((r) => r.agent === agent).map((r) => r.mode))];
export const scenariosIn = (results) => unique(results, (r) => r.scenario).map((r) => ({ id: r.scenario, title: r.title, harm: r.harm }));

// Runs of one suite, oldest first.
export const runsOf = (runs, suite) => runs.filter((r) => r.suite === suite).sort((a, b) => a.date.localeCompare(b.date));

// ------------------------------------------------------------- what moved ---

// Each run against the one before it, agent by agent. Three things can be
// said about an agent between two runs, and they are kept apart:
//   release   its version changed; cells that differ moved with that release
//   repeat    same version, measured again; every cell is expected to agree
//   unstable  same version, and a cell differs anyway (reported, never hidden)
export function compare(previous, current) {
  const before = lookup(bare(previous));
  const out = [];
  for (const agent of agentsIn(bare(current))) {
    const mine = bare(current).filter((r) => r.agent === agent && before(r));
    if (!mine.length) continue;
    const moved = mine.filter((r) => before(r).verdict !== r.verdict)
      .map((r) => ({ mode: r.mode, scenario: r.scenario, title: r.title, from: before(r).verdict, to: r.verdict, evidence: r.evidence }));
    const from = previous.versions[agent] ?? null, to = current.versions[agent] ?? null;
    const released = from !== to;
    const sameRig = (previous.rigHash ?? previous.rig) === (current.rigHash ?? current.rig);
    out.push({
      kind: released ? 'release' : moved.length ? (sameRig ? 'unstable' : 'rig') : 'repeat',
      suite: current.suite, agent, from, to, date: current.date, run: current.id, previousRun: previous.id,
      compared: mine.length, moved,
    });
  }
  return out;
}

// Everything the pages need, computed once from the run files.
export function history(runs) {
  const suites = {};
  for (const suite of SUITES) {
    const all = runsOf(runs, suite);
    const steps = all.slice(1).flatMap((run, i) => compare(all[i], run));
    const withCage = [...all].reverse().find((r) => caged(r).length) ?? null;
    suites[suite] = { runs: all, latest: all.at(-1) ?? null, steps, cage: withCage ? cageOf(withCage) : null };
  }
  const steps = SUITES.flatMap((s) => suites[s].steps);
  const repeats = steps.filter((s) => s.kind !== 'release');
  return {
    suites,
    // One entry per agent release (or per instability), both suites together, newest first.
    entries: entries(steps, runs),
    repeat: { cells: repeats.reduce((n, s) => n + s.compared, 0), same: repeats.reduce((n, s) => n + s.compared - s.moved.length, 0) },
    // The cell → verdict it had before the change that last moved it, for the latest model run.
    movedCells: latestMoves(suites),
  };
}

function entries(steps, runs) {
  const groups = new Map();
  for (const s of steps.filter((x) => x.kind !== 'repeat')) {
    const key = `${s.kind}\u0000${s.agent}\u0000${s.from}\u0000${s.to}`;
    const g = groups.get(key) ?? { kind: s.kind, agent: s.agent, from: s.from, to: s.to, date: s.date, steps: [] };
    if (s.date < g.date) g.date = s.date;
    g.steps.push(s);
    groups.set(key, g);
  }
  // A note belongs to the release it was written about, whichever run carries it.
  const notes = (g) => [...new Map(runs.filter((r) => r.versions[g.agent] === g.to)
    .flatMap((r) => r.notes ?? []).filter((n) => !n.agent || n.agent === g.agent).map((n) => [n.text, n])).values()];
  return [...groups.values()]
    .map((g) => ({ ...g, id: `${g.agent}-${g.to}`.replace(/[^\w.-]/g, '-'), moved: g.steps.reduce((n, s) => n + s.moved.length, 0), compared: g.steps.reduce((n, s) => n + s.compared, 0), notes: notes(g) }))
    .sort((a, b) => b.date.localeCompare(a.date) || b.moved - a.moved || a.agent.localeCompare(b.agent));
}

// For the latest run of each suite: cells whose verdict differs from the one
// the previous release of that agent had. Keyed "suite agent mode scenario".
function latestMoves(suites) {
  const out = {};
  for (const suite of SUITES) {
    const { latest, steps } = suites[suite];
    if (!latest) continue;
    for (const agent of agentsIn(bare(latest))) {
      const last = [...steps].reverse().find((s) => s.agent === agent && s.kind === 'release');
      if (!last || last.to !== latest.versions[agent]) continue;
      for (const m of last.moved) out[`${suite}\u0000${agent}\u0000${m.mode}\u0000${m.scenario}`] = { from: m.from, version: last.from };
    }
  }
  return out;
}
export const movedKey = (suite, r) => `${suite}\u0000${r.agent}\u0000${r.mode}\u0000${r.scenario}`;

// The same tests bare and inside the roll cage, from one run.
export function cageOf(run) {
  const inside = caged(run);
  const left = inside.filter((r) => r.verdict === 'EXPOSED');
  const tracked = left.filter((r) => r.undoRestored !== undefined);
  return {
    run, bare: count(bare(run)), caged: count(inside),
    stillExposed: [...new Set(left.map((r) => r.title))],
    restored: tracked.length ? tracked.filter((r) => r.undoRestored).length : null,
  };
}

// One agent, release by release: when each version was first measured and what it scored.
export function releases(runs, suite, agent) {
  const seen = new Map();
  for (const run of runsOf(runs, suite)) {
    const v = run.versions[agent];
    const mine = bare(run).filter((r) => r.agent === agent);
    if (!v || !mine.length) continue;
    const e = seen.get(v) ?? { version: v, first: run.date, last: run.date, runs: 0, counts: count(mine), source: run.source };
    e.last = run.date; e.runs += 1; e.counts = count(mine);
    seen.set(v, e);
  }
  return [...seen.values()].reverse();
}
