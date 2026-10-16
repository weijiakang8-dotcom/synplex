import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createModelDecoder} from '../../services/workspace/model-stream.mjs';
import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';

const scope={projectId:'chat-core',versionId:null,branchId:null};
const config={name:'测试连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:256,models:[{id:'fixture-model',name:'测试型号',capabilities:{tools:true,stream:true,efforts:['low','high'],contextWindow:32000}}]};
async function terminal(repository,auth,id){for(let i=0;i<100;i++){const value=repository.chat(auth,scope).get(id);if(!['queued','running'].includes(value.status))return value;await delay(5);}throw Error('Fixture did not complete');}
test('continuous chat HTTP persists selected model, context, cursor and usage; exact replay never resubmits',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-chat-'));let repository=new WorkspaceRepository({dataDir:dir}),server;
  const cred=repository.createCredential({ownerId:'test-owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task']}),auth=repository.authenticate(cred.token),calls=[];
  const connection=repository.models(auth,scope).save({requestId:'save-model',config,secret:'synthetic-only-test-key'});
  const transport=async input=>{calls.push(input);for(const content of ['这是','确定性夹具回复'])input.onChunk(Buffer.from('data: '+JSON.stringify({id:'provider-fixture',choices:[{delta:{content}}]})+'\n\n'));input.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:70,completion_tokens:8}})+'\n\ndata: [DONE]\n\n'));};
  try{
    server=createWorkspaceServer({repository,chatTransport:transport});const url=await server.listen();
    const post=async(path,input,token=cred.token)=>{const response=await fetch(url+'/api/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:PROTOCOL_VERSION,scope,...input})});return {status:response.status,body:await response.json()};};
    const conversation=(await post('ui_chat_create',{requestId:'create-one'})).body;
    const selection={connectionId:connection.id,model:'fixture-model',effort:'high'},input={conversationId:conversation.id,requestId:'message-one',content:'直接回答，合计不超过900字：我的第一个问题',selection,excludedClaimIds:[]};
    const reply=await post('ui_chat_send',input);assert.equal(reply.status,200);
    const one=await terminal(repository,auth,reply.body.id);assert.equal(one.status,'completed');assert.equal(one.answer,'这是确定性夹具回复');assert.equal(one.costUsd,null);assert.equal(one.usage.inputTokens,70);
    assert.match(calls[0].body.messages[0].content,/不超过900字/);assert.match(calls[0].body.messages[0].content,/540字左右/);assert.equal(calls[0].body.messages.filter(m=>m.role==='user').at(-1).content,input.content);assert.match(calls[0].body.messages.at(-1).content,/最多使用用户上限六成的可见字符/);assert.equal(one.content,input.content);assert.equal(calls[0].body.model,'fixture-model');assert.equal(calls[0].body.reasoning_effort,'high');assert.equal(calls[0].secret,'synthetic-only-test-key');assert.equal(calls[0].body.stream,true);
    const replay=await post('ui_chat_send',input);assert.equal(replay.body.id,one.id);assert.equal(calls.length,1);
    assert.equal((await post('ui_chat_send',{...input,content:'changed'})).status,409);
    const two=(await post('ui_chat_send',{...input,requestId:'message-two',content:'接着刚才的问题',selection:{...selection,effort:'low'}})).body;
    await terminal(repository,auth,two.id);assert.equal(calls.length,2);assert.doesNotMatch(calls[1].body.messages[0].content,/本次用户明确要求整份回复/);assert.equal(calls[1].body.reasoning_effort,'low');assert.ok(calls[1].body.messages.some(m=>m.role==='assistant'&&m.content===one.answer));
    const events=(await post('ui_chat_events',{id:one.id,cursor:0})).body;assert.equal(events.status,'completed');assert.equal(events.events.map(e=>e.delta).join(''),one.answer);
    const empty=(await post('ui_chat_events',{id:one.id,cursor:events.sequence})).body;assert.equal(empty.events.length,0);
    const other=repository.createCredential({ownerId:'another',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task']});
    assert.equal((await post('ui_chat_history',{conversationId:conversation.id,cursor:null},other.token)).status,403);
    assert.equal(calls.length,2);await server.close();server=null;repository.close();
    repository=new WorkspaceRepository({dataDir:dir});const resumed=repository.authenticate(cred.token),history=repository.chat(resumed,scope).history(conversation.id);
    assert.equal(history.items.length,2);assert.equal(history.items[0].answer,one.answer);assert.equal(history.items[1].selection.effort,'low');assert.equal(calls.length,2);
  }finally{await server?.close();repository.close();rmSync(dir,{recursive:true,force:true});}
});
test('cancel unwinds original request; interrupted unknown requires review, never automatic replay',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-chat-stop-')),repository=new WorkspaceRepository({dataDir:dir});let calls=0;
  const cred=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task']}),auth=repository.authenticate(cred.token),chat=repository.chat(auth,scope);
  const connection=repository.models(auth,scope).save({requestId:'model',config,secret:'synthetic-cancel-key'});
  const transport=async input=>{calls++;input.onChunk(Buffer.from('data: '+JSON.stringify({choices:[{delta:{content:'已返回的一部分'}}]})+'\n\n'));await new Promise((_,reject)=>input.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}));};
  const {ChatService}=await import('../../services/workspace/chat-service.mjs');const service=new ChatService({repository,transport});
  try{
    const conversation=chat.create('create'),input={conversationId:conversation.id,requestId:'message',content:'等待并停止',selection:{connectionId:connection.id,model:'fixture-model',effort:null},excludedClaimIds:[],scope};
    const started=await service.send(auth,input);await delay(10);const stopped=await service.stop(auth,scope,started.id);assert.equal(stopped.status,'stopped');assert.equal(stopped.answer,'已返回的一部分');assert.equal(calls,1);
    assert.equal((await service.send(auth,input)).id,started.id);assert.equal(calls,1);
    const next=await service.send(auth,{...input,requestId:'restart',content:'模拟服务中断'});await delay(10);await service.close();
    assert.equal(chat.get(next.id).status,'unknown');await assert.rejects(service.send(auth,{...input,requestId:'new'}));
    chat.acknowledge(next.id);assert.equal(chat.get(next.id).status,'reviewed');assert.equal(chat.get(next.id).costUsd,null);assert.equal(calls,2);
  }finally{await service.close();repository.close();rmSync(dir,{recursive:true,force:true});}
});
test('stream decoder ignores hidden reasoning, preserves Unicode splits and detects incomplete output',()=>{
  let answer='';const decoder=createModelDecoder({stream:true,onText:t=>answer+=t});
  const bytes=Buffer.from('data: '+JSON.stringify({id:'reply',choices:[{delta:{content:'你好',reasoning_content:'PRIVATE'}}]})+'\r\n\r\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2}})+'\n\ndata: [DONE]\n\n');
  for(let i=0;i<bytes.length;i+=7)decoder.push(bytes.subarray(i,i+7));assert.equal(decoder.finish().usage.inputTokens,3);assert.equal(answer,'你好');
  const broken=createModelDecoder({stream:true,onText:()=>{}});broken.push(Buffer.from('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'));assert.throws(()=>broken.finish(),/中断/);
  const limited=createModelDecoder({stream:true,onText:()=>{}});limited.push(Buffer.from('data: {"choices":[{"delta":{"content":"部分内容"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}\n\ndata: [DONE]\n\n'));assert.equal(limited.finish().truncated,true);assert.equal(limited.evidence().usage.outputTokens,2);
  const emptyLimited=createModelDecoder({stream:true,onText:()=>assert.fail('hidden reasoning must stay hidden')});emptyLimited.push(Buffer.from('data: {"choices":[{"delta":{"reasoning_content":"private"},"finish_reason":"length"}],"usage":{"prompt_tokens":3,"completion_tokens":256}}\n\ndata: [DONE]\n\n'));assert.equal(emptyLimited.finish().empty,true);assert.equal(emptyLimited.evidence().usage.outputTokens,256);
  const responses=createModelDecoder({stream:true,onText:t=>answer=t});responses.push(Buffer.from('data: {"type":"response.output_text.delta","delta":"新版回复"}\n\ndata: {"type":"response.completed","response":{"id":"r1","usage":{"input_tokens":4,"output_tokens":2}}}\n\n'));assert.equal(responses.finish().providerReceipt,'r1');assert.equal(answer,'新版回复');
});

test('DNS preflight failure is a known unsent failure; output transfer bounds include streaming envelopes',async()=>{
 const {modelTransferLimits}=await import('../../services/workspace/model-network.mjs');
 const {modelConnectionFailure}=await import('../../services/workspace/model-error.mjs');
 assert.equal(modelTransferLimits(16384).maxBytes,16*1024*1024);assert.equal(modelTransferLimits(1000000).maxBytes,32*1024*1024);
 const dir=mkdtempSync(join(tmpdir(),'synplex-chat-dns-')),r=new WorkspaceRepository({dataDir:dir});
 const c=r.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','prepare_task','review_memory']}),auth=r.authenticate(c.token),chat=r.chat(auth,scope),connection=r.models(auth,scope).save({requestId:'model',config,secret:'synthetic-test-key'});
 const {ChatService}=await import('../../services/workspace/chat-service.mjs');let calls=0;const service=new ChatService({repository:r,transport:async()=>{calls++;const e=modelConnectionFailure('fakeDns');e.requestSent=false;throw e;}});
 try{const conversation=chat.create('dns'),value=await service.send(auth,{scope,conversationId:conversation.id,requestId:'dns-message',content:'问候',selection:{connectionId:connection.id,model:'fixture-model',effort:null},excludedClaimIds:[]}),result=await terminal(r,auth,value.id);assert.equal(result.status,'failed');assert.match(result.notice,/本次没有发送给模型/);assert.equal(result.usage,null);assert.equal(calls,1);}finally{await service.close();r.close();rmSync(dir,{recursive:true,force:true});}
});
