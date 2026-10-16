import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {setup,input,meta,scope} from './helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {validateCuration} from '../../packages/ingestion/event-curation.mjs';

test('event organization is a sourced pending proposal, preserves failures and exact replay across restart',async t=>{
 const h=await setup(t),cred=h.repository.createCredential({ownerId:'test-owner',actorId:'curator',scope,kind:'ui',capabilities:['read_memory','write_memory','prepare_task','review_memory']}),auth=h.repository.authenticate(cred.token);
 for(const text of ['失败：旧方案覆盖原件，尚未通过验收。旧要求合计不超过900字。','决定：改为保留原稿和新版，避免修改时丢失历史。'])await importSource(h.repo,input(text),await meta(h.repo));
 const c=h.repository.models(auth,scope).save({requestId:'model',secret:'synthetic-key-only',config:{name:'测试连接',endpoint:'https://api.example.com',protocol:'chat-completions',maxOutputTokens:1024,models:[{id:'fixture',name:'夹具',capabilities:{tools:false,stream:true,efforts:[],contextWindow:64000}}]}});
 let calls=0,bad=false,empty=false;
 const transport=async request=>{
  calls++;assert.doesNotMatch(request.body.messages[0].content,/本次用户明确要求整份回复/);const content=request.body.messages.at(-1).content,claims=JSON.parse(content.split('原文线索：\n')[1]);
  const answer=empty?'':JSON.stringify(bad?{events:[],discarded:claims.map(c=>({claimId:c.id,reason:'忽略失败记录'}))}:{events:[{claimIds:claims.map(c=>c.id),type:'lesson',title:'改稿保留原件',body:'旧方案覆盖原件导致失败，尚未通过验收；决定保留原稿和新版，防止历史丢失。',condition:'需要修改已有交付时，仍需独立验收新版。'}],discarded:[]});
  request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:answer}}]})+'\n\n'));
  request.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{},finish_reason:empty?'length':'stop'}],usage:{prompt_tokens:50,completion_tokens:30}})+'\n\ndata: [DONE]\n\n'));
 };
 let server=createWorkspaceServer({repository:h.repository,chatTransport:transport}),url=await server.listen();
 t.after(()=>server.close());
 const post=async(name,data)=>{const r=await fetch(url+'/api/v1/'+name,{method:'POST',headers:{authorization:'Bearer '+cred.token,'content-type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,...data})});return {status:r.status,body:await r.json()};};
 const req={requestId:randomUUID(),expectedStateRevision:(await h.repo.getRevision()).stateRevision,selection:{connectionId:c.id,model:'fixture',effort:null}};
 const started=await post('ui_curate_start',req);assert.equal(started.status,200);
 let result;for(let i=0;i<100;i++){result=await post('ui_curate_state',{id:started.body.id});if(result.body.status==='completed')break;await delay(5);}
 assert.equal(result.body.status,'completed');assert.equal(result.body.outputCount,1);assert.equal(calls,1);
 const page=h.repository.pendingPage(h.auth,scope);assert.equal(page.selection.curatedEvents,1);assert.equal(page.selection.rawSignals,0);assert.equal(page.total,1);assert.equal(page.items[0].reviewStatus,'pending');assert.equal(page.items[0].evidence.length,2);assert.equal(page.items[0].type,'lesson');
 assert.equal((await h.repo.getState()).lessons.length,0);assert.equal(h.repository.list(h.auth,scope,'claim').length,3);
 const batch=h.repository.curation(auth,scope,started.body.id);
 assert.ok(batch.prompt.includes('原文线索：'));assert.equal(h.repository.chat(auth,scope).get(batch.chatId).content,batch.prompt);
 assert.throws(()=>validateCuration(batch,JSON.stringify({events:[],discarded:batch.claims.map(c=>({claimId:c.id,reason:'没有价值，丢掉负结果'}))})),e=>e.code==='conflict');
 const event={claimIds:batch.claims.map(c=>c.id),type:'lesson',title:'保留原件',body:'失败尚未通过，必须保留历史；完成率为99%。',condition:'修改成果时'};
 assert.throws(()=>validateCuration(batch,JSON.stringify({events:[event],discarded:[]})),e=>e.code==='conflict');
 assert.throws(()=>validateCuration(batch,JSON.stringify({events:[{...event,body:'方案完全成功。'}],discarded:[]})),e=>e.code==='conflict');
 const symptom={claims:[{...batch.claims[0],id:'symptom',body:'报错现象：前端连接被拒绝。'}]};
 const symptomEvent={claimIds:['symptom'],type:'failure',title:'前端连接被拒绝',body:'前端连接被拒绝，原文没有修复结果。',condition:'仅描述原始故障，仍需核对修复效果。'};
 assert.equal(validateCuration(symptom,JSON.stringify({events:[symptomEvent],discarded:[]})).candidates.length,1);
 assert.throws(()=>validateCuration(symptom,JSON.stringify({events:[{...symptomEvent,title:'连接正常',body:'已经恢复正常。'}],discarded:[]})),e=>e.code==='conflict');
 assert.equal((await post('ui_curate_start',req)).body.status,'completed');assert.equal(calls,1);
 await server.close();await h.reopen();server=createWorkspaceServer({repository:h.repository,chatTransport:transport});url=await server.listen();
 assert.equal((await post('ui_curate_state',{id:batch.id})).body.status,'completed');assert.equal(calls,1);assert.equal(h.repository.pendingPage(h.auth,scope).total,1);
 await importSource(h.repo,input('失败：第二次修改尚未完成，必须保留原文件。'),await meta(h.repo));bad=true;
 const rejected=await post('ui_curate_start',{...req,requestId:randomUUID(),expectedStateRevision:(await h.repo.getRevision()).stateRevision});
 for(let i=0;i<100;i++){result=await post('ui_curate_state',{id:rejected.body.id});if(result.body.status==='needs_review')break;await delay(5);}
 assert.equal(result.body.status,'needs_review');assert.equal(calls,2);
 assert.equal(h.repository.curation(h.repository.authenticate(cred.token),scope,rejected.body.id).status,'failed');
 assert.equal((await post('ui_curate_state',{id:rejected.body.id})).body.status,'needs_review');assert.equal(calls,2);
 assert.ok(h.repository.pendingPage(h.auth,scope).items.some(c=>c.body.includes('第二次修改尚未完成')));
 const repeat=await post('ui_curate_start',{...req,requestId:randomUUID(),expectedStateRevision:(await h.repo.getRevision()).stateRevision});
 assert.notEqual(repeat.status,200);assert.equal(calls,2);
 assert.equal(h.repository.curation(h.repository.authenticate(cred.token),scope,rejected.body.id).status,'failed');
 await importSource(h.repo,input('失败：第三次修改尚未完成，必须保留原稿和新版。'),await meta(h.repo));
 empty=true;
 const noReply=await post('ui_curate_start',{...req,requestId:randomUUID(),expectedStateRevision:(await h.repo.getRevision()).stateRevision});
 for(let i=0;i<100;i++){result=await post('ui_curate_state',{id:noReply.body.id});if(result.body.status==='needs_review')break;await delay(5);}
 assert.equal(result.body.status,'needs_review');assert.equal(calls,3);
 assert.equal(h.repository.curation(h.repository.authenticate(cred.token),scope,noReply.body.id).status,'failed');
 assert.match(result.body.notice,/没有重新发送/);
 await post('ui_curate_state',{id:noReply.body.id});assert.equal(calls,3);

});
