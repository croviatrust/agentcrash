import test from 'node:test';
import assert from 'node:assert/strict';
import { api } from './github.mjs';
test('a transient GitHub read failure is retried within a fixed budget',async()=>{
  let calls=0;const delays=[];
  const value=await api('/repos/example/project/git/commits/abc',{wait:async ms=>delays.push(ms),fetcher:async()=>++calls<3?new Response('',{status:502}):Response.json({sha:'abc'})});
  assert.equal(calls,3);assert.deepEqual(delays,[500,1000]);assert.equal(value.sha,'abc');
});
test('permanent reads and exhausted transient errors stay visible',async()=>{
  for(const [status,expected] of [[403,1],[404,1],[502,3]]){
    let calls=0;
    await assert.rejects(api('/repos/example/project',{wait:async()=>{},fetcher:async()=>{calls++;return new Response('',{status});}}),new RegExp(String(status)));
    assert.equal(calls,expected);
  }
  assert.equal(await api('/repos/example/project',{missing:true,fetcher:async()=>new Response('',{status:404})}),null);
});
test('ambiguous writes are never replayed automatically',async()=>{
  for(const method of ['POST','PATCH']){
    let calls=0;
    await assert.rejects(api('/repos/example/project/git/refs',{method,body:{},wait:async()=>{},fetcher:async()=>{calls++;return new Response('',{status:502});}}),/502/);
    assert.equal(calls,1);
  }
});
test('read transport failures retry while write transport failures do not',async()=>{
  for(const method of ['GET','POST']){
    let calls=0;
    await assert.rejects(api('/repos/example/project',{method,wait:async()=>{},fetcher:async()=>{calls++;throw new Error('transport unavailable');}}),/transport/);
    assert.equal(calls,method==='GET'?3:1);
  }
});
