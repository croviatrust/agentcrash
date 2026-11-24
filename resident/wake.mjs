// Trusted controller only: bounded continuation, independent of cron delivery.
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { api } from './github.mjs';
export function continuationPlan(state, { depth = 0, now = Date.now() } = {}) {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= 6) return null;
  const latest = state.recent?.at(-1);
  if (!latest || (state.recent || []).some(e => ['awaiting-crovia-identity', 'pr-blocked'].includes(e.status))) return null;
  const task = state.agenda?.tasks.find(t => t.repo === latest.repo && t.lastEpisode === latest.id && t.status === 'needs-research' && (t.recoveryCycles || 0) < 6);
  const due = Date.parse(task?.cooldownUntil);
  if (!task || !Number.isFinite(due) || due > now + 15 * 60000) return null;
  return { episode: latest.id, task: task.id, depth: depth + 1, due, waitMs: Math.max(0, due - now) };
}
export async function resume(repo, { request = api, wait = ms => new Promise(resolve => setTimeout(resolve, ms)), depth = 0, log = console.log } = {}) {
  const route = `/repos/${repo}`;
  async function memory() {
    const file = await request(`${route}/contents/state.json?ref=crovia-memory`);
    return JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  const plan = continuationPlan(await memory(), { depth });
  if (!plan) { log(JSON.stringify({ event: 'continuation-not-needed' })); return null; }
  // Wait in short chunks, then re-read authoritative memory. No model runs here.
  let remaining = plan.waitMs;
  while (remaining > 0) { const chunk = Math.min(remaining, 30000); await wait(chunk); remaining -= chunk; }
  const fresh = continuationPlan(await memory(), { depth });
  if (!fresh || fresh.episode !== plan.episode || fresh.waitMs > 1000) { log(JSON.stringify({event:'continuation-obsolete',episode:plan.episode})); return null; }
  const meta = await request(route);
  await request(`${route}/actions/workflows/resident.yml/dispatches`, { method: 'POST', body: { ref: meta.default_branch, inputs: { expected_episode: plan.episode, continuation_depth: String(plan.depth) } } });
  log(JSON.stringify({ event: 'continuation-dispatched', ...plan }));
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `Continuation dispatched for ${plan.episode}; depth ${plan.depth}/6. Next run must confirm execution.\n`);
  return plan;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  await resume(process.env.GITHUB_REPOSITORY, { depth: Number(process.env.CONTINUATION_DEPTH || 0) });
