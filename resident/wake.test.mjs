import test from 'node:test';
import assert from 'node:assert/strict';
import { continuationPlan, resume } from './wake.mjs';
const repo='croviatrust/agentcrash';
const seed = () => ({recent:[{id:'episode-1',repo,status:'stopped'}],agenda:{tasks:[{id:'work',repo,lastEpisode:'episode-1',status:'needs-research',recoveryCycles:2,cooldownUntil:new Date(Date.now()-1000).toISOString()}]}});
test('continuation requires the newest failed commitment and bounded recovery depth',()=>{
  const state=seed(); assert.equal(continuationPlan(state).episode,'episode-1');
  for(const depth of [-1,6,7,NaN]) assert.equal(continuationPlan(state,{depth}),null);
  state.agenda.tasks[0].recoveryCycles=6; assert.equal(continuationPlan(state),null);
  state.agenda.tasks[0].recoveryCycles=2; state.agenda.tasks[0].status='awaiting-review'; assert.equal(continuationPlan(state),null);
  state.agenda.tasks[0].status='needs-research'; state.recent.push({id:'new',repo,status:'stopped'}); assert.equal(continuationPlan(state),null);
});
test('confirmed continuation dispatches the default branch with a stale-work guard',async()=>{
  const state=seed(),calls=[];
  const result=await resume(repo,{depth:2,log:()=>{},request:async(route,options)=>{calls.push({route,options});if(route.includes('/contents/'))return {content:Buffer.from(JSON.stringify(state)).toString('base64')};if(!options)return {default_branch:'main'};return null;}});
  assert.equal(result.depth,3); assert.equal(calls.at(-1).options.method,'POST');
  assert.deepEqual(calls.at(-1).options.body,{ref:'main',inputs:{expected_episode:'episode-1',continuation_depth:'3'}});
});
test('obsolete work and pending proposals never dispatch a duplicate continuation',async()=>{
  const state=seed();let reads=0,posts=0;
  await resume(repo,{log:()=>{},request:async(route,options)=>{if(options)posts++;if(++reads===2)state.recent.push({id:'new',repo,status:'stopped'});return {content:Buffer.from(JSON.stringify(state)).toString('base64')};}});
  assert.equal(posts,0); state.recent=[{id:'episode-1',repo,status:'awaiting-crovia-identity'}]; assert.equal(continuationPlan(state),null);
});
test('dispatch failures remain failures rather than reporting a successful restart',async()=>{
  const state=seed();let reported=false;
  await assert.rejects(resume(repo,{log:s=>{if(s.includes('continuation-dispatched'))reported=true;},request:async(route,options)=>{if(options)throw new Error('dispatch denied');return route.includes('/contents/')?{content:Buffer.from(JSON.stringify(state)).toString('base64')}:{default_branch:'main'};}}),/dispatch denied/);
  assert.equal(reported,false);
});
test('cooldown waits in bounded chunks and memory is rechecked before dispatch',async()=>{
  const state=seed();state.agenda.tasks[0].cooldownUntil=new Date(Date.now()+65000).toISOString();
  const waits=[];let posted=false;
  await resume(repo,{log:()=>{},wait:async ms=>{waits.push(ms);state.agenda.tasks[0].cooldownUntil=new Date(Date.now()-1).toISOString();},request:async(route,options)=>{if(options){posted=true;return null;}return route.includes('/contents/')?{content:Buffer.from(JSON.stringify(state)).toString('base64')}:{default_branch:'main'};}});
  assert.ok(waits.length>=3);assert.ok(waits.every(ms=>ms<=30000));assert.ok(posted);
});
