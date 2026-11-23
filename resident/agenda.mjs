// Persistent work, distinct from run history. Tests and merges never mean adoption.
import crypto from 'node:crypto';
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
const terminal = new Set(['completed', 'rejected', 'blocked']);
export function refreshAgenda(previous, repo, context, outcomes = {}, episodes = []) {
  const agenda = structuredClone(previous || { version: 1, tasks: [] });
  const sources = [
    ...(context.issues || []).slice(0, 8).map(i => ({ key: `issue:${repo}:${i.number}`, objective: String(i.title).slice(0, 500),
      source: `https://github.com/${repo}/issues/${i.number}`, evidence: [i.title, i.body, i.updated], goal: 'maintain' })),
    ...(context.opportunities || []).slice(0, 4).map(o => ({ key: o.id, objective: `Investigate the reported need: ${o.title}`.slice(0, 500),
      source: o.url, evidence: o.evidenceHash, goal: 'create' }))
  ];
  if (context.latestEncounter?.cohorts?.some(c => !c.score?.correct)) sources.unshift({ key: 'encounter-usability',
    objective: 'Reproduce and reduce the failures in the latest controlled agent encounter.', source: `encounters/${context.latestEncounter.id}.json`,
    evidence: context.latestEncounter, goal: 'adopt' });
  for (const s of sources) {
    const id = `work-${hash([repo, s.key])}`, revision = hash(s.evidence);
    let task = agenda.tasks.find(t => t.id === id);
    if (!task) { task = { id, repo, goal: s.goal, objective: s.objective, source: s.source, evidenceHash: revision, status: 'queued', attempts: 0, checkpoints: [] }; agenda.tasks.push(task); }
    else if (task.evidenceHash !== revision && task.status !== 'awaiting-review') {
      task.evidenceHash = revision; task.objective = s.objective; task.source = s.source;
      task.status = 'queued'; task.attempts = 0; task.next = 'Source evidence changed; re-evaluate rather than assume the old diagnosis.';
    }
  }
  for (const task of agenda.tasks) {
    if (task.repo !== repo) continue;
    const linked = episodes.find(e => e.id === task.lastEpisode);
    if (!task.pr && linked?.pr) task.pr = linked.pr;
    if (!task.pr && linked?.status === 'discarded') task.status = 'rejected';
    if (!task.pr) continue;
    const outcome = outcomes[String(task.pr)];
    if (outcome === 'merged') { task.status = 'completed'; task.completion = 'Candidate merged; user benefit and adoption remain unmeasured.'; }
    else if (outcome === 'rejected') task.status = 'rejected';
  }
  // A trusted default-branch assignment selects an existing issue; it cannot
  // invent evidence or revive a completed/blocked commitment.
  const assigned = context.maintainerAssignment?.issueNumber;
  if (Number.isSafeInteger(assigned) && assigned > 0) {
    const selected = agenda.tasks.find(t => t.repo === repo && t.source === `https://github.com/${repo}/issues/${assigned}` && ['queued', 'active'].includes(t.status));
    if (selected) agenda.tasks = [selected, ...agenda.tasks.filter(t => t.id !== selected.id)];
  }
  // Retain open work before completed history, with a strict memory bound.
  agenda.tasks = [...agenda.tasks.filter(t => !terminal.has(t.status)), ...agenda.tasks.filter(t => terminal.has(t.status))].slice(0, 24);
  return agenda;
}
export function chooseCommitment(agenda, repo) {
  return (agenda?.tasks || []).find(t => t.repo === repo && ['active', 'queued'].includes(t.status) && t.attempts < 3) || null;
}
export function advanceAgenda(previous, episode, verdict) {
  const agenda = structuredClone(previous || { version: 1, tasks: [] });
  if (!episode.commitment) return agenda;
  const task = agenda.tasks.find(t => t.id === episode.commitment.id && t.repo === episode.repo);
  if (!task || task.evidenceHash !== episode.commitment.evidenceHash) return agenda;
  task.attempts++;
  task.lastEpisode = episode.id;
  task.next = String(episode.next || episode.reason || '').slice(0, 800);
  task.checkpoints = [...task.checkpoints, { episode: episode.id, status: episode.status, verdict: verdict.status,
    next: task.next, baseSHA: episode.baseSHA }].slice(-3);
  if (episode.pr || ['awaiting-crovia-identity', 'pr-blocked'].includes(episode.status)) {
    task.status = 'awaiting-review'; task.pr = episode.pr || null; task.candidate = episode.url;
  } else task.status = task.attempts >= 3 ? 'blocked' : 'active';
  return agenda;
}
export function missionBrief(task) {
  return task ? { id: task.id, goal: task.goal, objective: task.objective, source: task.source, evidenceHash: task.evidenceHash,
    attempts: task.attempts, next: task.next, checkpoints: task.checkpoints } : null;
}
