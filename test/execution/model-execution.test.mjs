import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {modelChoiceId} from '../../services/workspace/model-relay.mjs';
import * as context from '../../packages/context/index.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
const scope={projectId:'model-execution',branchId:null,versionId:null},protocolVersion='synplex.workspace/1.0.0';
const pricing={validFrom:'2026-01-01T00:00:00Z',validUntil:null,inputUsdPerMillion:1,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:2,source:'synthetic-price-fixture'};
const config={name:'个人执行连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:256,models:[{id:'actual-model',name:'所选型号',pricing,capabilities:{tools:true,stream:false,efforts:['high'],contextWindow:32000}}]};
test('execution-scoped relay uses exact personal choice, persists usage and deduplicates calls; unknown/revoked cannot send',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-execution-model-')),repository=new WorkspaceRepository({dataDir:dir});let server,engineCalls=0,providerCalls=0,url,secretBinding,checked=false;
  const human=repository.createCredential({ownerId:'one',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']}),auth=repository.authenticate(human.token);
  const connection=repository.models(auth,scope).save({requestId:'save',config,secret:'synthetic-provider-private-key'}),options={model:modelChoiceId(connection.id,'actual-model'),effort:'high'};
  const relay=repository.modelRelay({transport:async input=>{providerCalls++;assert.equal(input.secret,'synthetic-provider-private-key');assert.equal(input.endpoint,config.endpoint);assert.equal(input.body.model,'actual-model');assert.equal(input.body.reasoning_effort,'high');assert.equal(input.body.max_tokens,1);if(input.body.messages[0].content==='failure')throw Error('synthetic-lost-reply');input.onChunk(Buffer.from(JSON.stringify({id:'provider-record',choices:[{message:{content:'实际HTTP夹具回复'}}],usage:{prompt_tokens:15,completion_tokens:4,prompt_tokens_details:{cached_tokens:2}}})));}});
  const adapter={mode:'platform_owned',getSelectionChoices:(a,s)=>a?relay.choices(a,s):[],validateSelection:(o,c)=>relay.validate(c.auth,c.scope,o),execute:async input=>{
    engineCalls++;secretBinding=relay.grant(auth,scope,{operationId:input.operationId,attemptId:input.attemptId,options,endpoint:url+'/internal/model/v1'});
    const call=body=>fetch(secretBinding.endpoint+'/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+secretBinding.token,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const body={model:options.model,reasoning_effort:'high',max_completion_tokens:1,messages:[{role:'user',content:'first'}],stream:false};
    assert.equal((await call({...body,reasoning_effort:'low'})).status,409);assert.equal(providerCalls,0);
    const oversized=await call({...body,messages:[{role:'user',content:'x'.repeat(32000)}]});assert.equal(oversized.status,409);assert.equal((await oversized.json()).error.type,'budget_exceeded');assert.equal(providerCalls,0);
    const one=await call(body);assert.equal(one.status,200);const first=await one.json();assert.equal(first.choices[0].message.content,'实际HTTP夹具回复');assert.equal((await call(body)).status,200);assert.equal(providerCalls,1);
    const usage=relay.usage(auth,scope,input.operationId);assert.equal(usage.inputTokens,15);assert.equal(usage.cachedInputTokens,2);assert.equal(usage.costUsd,null);assert.equal(usage.model,'actual-model');
    const priced=repository.usageLedger(auth,scope).rows.find(r=>r.attemptId===input.attemptId);assert.ok(Math.abs(priced.calculatedUsd-0.0000212)<1e-12);assert.equal(priced.paidUsd,null);assert.equal(relay.calls(auth,scope,input.operationId)[0].priceSnapshot.source,pricing.source);
    assert.equal((await call({...body,messages:[{role:'user',content:'failure'}]})).status,409);assert.equal(providerCalls,2);assert.equal((await call({...body,messages:[{role:'user',content:'failure'}]})).status,409);assert.equal(providerCalls,2);
    assert.equal((await call({...body,messages:[{role:'user',content:'third'}]})).status,409);assert.equal(providerCalls,2);
    assert.equal(relay.calls(auth,scope,input.operationId).filter(c=>c.status==='unknown').length,1);
    assert.throws(()=>repository.models(auth,scope).change({requestId:'rotate-while-unknown',id:connection.id,revision:1,action:'disable'}),/仍有任务/);
    repository.revokeCredential(human.id);assert.equal((await call(body)).status,409);assert.equal(providerCalls,2);
    checked=true;throw Error('Preserve original operation for reconciliation');
  }};
  const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter}});
  try{
    server=createWorkspaceServer({repository,modules:{context},execution,modelRelay:relay});url=await server.listen();
    const post=async(action,input)=>{const response=await fetch(url+'/api/v1/'+action,{method:'POST',headers:{Authorization:'Bearer '+human.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion,scope,...input})});return {status:response.status,body:await response.json()};};
    const capabilities=await fetch(url+'/api/v1/capabilities',{headers:{Authorization:'Bearer '+human.token}}).then(r=>r.json());assert.equal(capabilities.executors[0].selectionChoices[0].id,options.model);
    const other=repository.authenticate(repository.createCredential({ownerId:'two',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory','execute']}).token);assert.equal(execution.executors(other,scope)[0].selectionChoices.length,0);
    const revision=()=>repository.state(auth,scope).stateRevision;
    const prep=await post('prepare_task',{requestId:'prepare',expectedStateRevision:revision(),goal:'核对个人模型实际执行',constraints:[],acceptanceCriteria:['参数及用量有原请求依据'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:6000,executionOptions:options});assert.equal(prep.status,200,JSON.stringify(prep.body));
    const input={requestId:'execute',expectedStateRevision:revision(),runId:prep.body.run.id},authorization=await post('authorize_execution',input);
    const started=await post('execute_task',{...input,authorizationId:authorization.body.authorizationId});assert.equal(started.status,202,JSON.stringify(started.body));await execution.idle();assert.equal(engineCalls,1);assert.equal(providerCalls,2);assert.equal(checked,true);
    assert.equal((await fetch(url+'/internal/model/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,403);
  }finally{await server?.close();repository.close();rmSync(dir,{recursive:true,force:true});}
});

test('terminal unknown model call has a scoped review exit; replacing a revoked UI credential never replays the request or fabricates zero cost',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-model-review-')),repository=new WorkspaceRepository({dataDir:dir});let server,providerCalls=0;
 const credential=actorId=>repository.createCredential({ownerId:'one',actorId,scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task','record_result','execute']});
 const first=credential('human'),auth=repository.authenticate(first.token),connection=repository.models(auth,scope).save({requestId:'save',config,secret:'synthetic-unknown-reply-key'}),options={model:modelChoiceId(connection.id,'actual-model'),effort:'high'};
 const relay=repository.modelRelay({transport:async()=>{providerCalls++;throw Error('Synthetic connection lost after submit');}});
 try{
  const service=new WorkspaceService({repository,modules:{context}}),prepared=await service.call(auth,'prepare_task',{protocolVersion,scope,requestId:'prep',expectedStateRevision:0,goal:'核对中断后的请求',constraints:[],acceptanceCriteria:['不重复计费提交'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:6000,executionOptions:options});
  const input={protocolVersion,scope,requestId:'execute',expectedStateRevision:0,runId:prepared.run.id},authorization=repository.issueExecutionAuthorization(auth,input),admitted=repository.admitExecution(auth,{...input,authorizationId:authorization.authorizationId}),job=repository.claimExecution(auth,scope,admitted.operationId);
  const binding=relay.grant(auth,scope,{operationId:job.operationId,attemptId:job.attemptId,options,endpoint:'http://127.0.0.1:5418/internal/model/v1'}),body={model:options.model,reasoning_effort:'high',messages:[{role:'user',content:'one request'}]};
  await assert.rejects(relay.call(binding.token,'/chat/completions',body),/尚需核对/);assert.equal(providerCalls,1);assert.throws(()=>relay.review(auth,scope,job.operationId),/还没有核对结束/);
  const result={eventId:'failed-model-request',attemptId:job.attemptId,provider:'fixture',summary:'请求中断，保留实际未知结果',artifacts:[],checks:[],usage:relay.usage(auth,scope,job.operationId),supersedesResultId:null,occurredAt:null};
  repository.saveExecutionReceipt(auth,scope,job.operationId,job.claimId,{status:'failed',result});repository.flushExecutionReceipt(auth,scope,job.operationId);
  repository.revokeCredential(first.id);const replacement=credential('human'),resumed=repository.authenticate(replacement.token),other=repository.authenticate(credential('another').token);
  assert.throws(()=>relay.review(other,scope,job.operationId),/权限|访问/);
  server=createWorkspaceServer({repository,modules:{context},modelRelay:relay});const url=await server.listen();
  const response=await fetch(url+'/api/v1/ui_review_model_calls',{method:'POST',headers:{Authorization:'Bearer '+replacement.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion,scope,operationId:job.operationId,confirmed:true})});assert.equal(response.status,200);const reviewed=await response.json();
  assert.equal(reviewed.calls[0].status,'reviewed');assert.equal(reviewed.calls[0].costUsd,null);assert.deepEqual(relay.review(resumed,scope,job.operationId),reviewed);
  await assert.rejects(relay.call(binding.token,'/chat/completions',body),/已失效/);assert.equal(providerCalls,1);
  assert.equal(repository.models(resumed,scope).change({requestId:'disable',id:connection.id,revision:1,action:'disable'}).enabled,false);
 }finally{await server?.close();repository.close();rmSync(dir,{recursive:true,force:true});}
});

test('output limit preserves charged reply, replays only saved bytes and blocks further paid requests with an actionable explanation',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-model-length-')),repository=new WorkspaceRepository({dataDir:dir});let sends=0;
 try{
  const credential=repository.createCredential({ownerId:'length-owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task','record_result','execute']}),auth=repository.authenticate(credential.token);
  const connection=repository.models(auth,scope).save({requestId:'save',config,secret:'synthetic-length-test-key'}),options={model:modelChoiceId(connection.id,'actual-model'),effort:'high'};
  const relay=repository.modelRelay({transport:async input=>{sends++;input.onChunk(Buffer.from(JSON.stringify({id:'length-receipt',choices:[{message:{content:'',tool_calls:[{id:'partial',type:'function',function:{name:'export_document',arguments:'{"content":"未完整'}}]},finish_reason:'length'}],usage:{prompt_tokens:21,completion_tokens:256}})));}});
  const service=new WorkspaceService({repository,modules:{context}}),prepared=await service.call(auth,'prepare_task',{protocolVersion,scope,requestId:'prepare',expectedStateRevision:0,goal:'生成文档',constraints:[],acceptanceCriteria:['实际文件'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:6000,executionOptions:options});
  const request={protocolVersion,scope,requestId:'start',expectedStateRevision:0,runId:prepared.run.id},authorization=repository.issueExecutionAuthorization(auth,request),admitted=repository.admitExecution(auth,{...request,authorizationId:authorization.authorizationId}),job=repository.claimExecution(auth,scope,admitted.operationId);
  const binding=relay.grant(auth,scope,{operationId:job.operationId,attemptId:job.attemptId,options,endpoint:'http://127.0.0.1:5431/internal/model/v1'}),body={model:options.model,reasoning_effort:'high',messages:[{role:'user',content:'original'}]};
  const first=await relay.call(binding.token,'/chat/completions',body),again=await relay.call(binding.token,'/chat/completions',body);assert.equal(again.replayed,true);assert.deepEqual(again.bytes,first.bytes);assert.equal(sends,1);
  await assert.rejects(relay.call(binding.token,'/chat/completions',{...body,messages:[{role:'user',content:'repair'}]}),e=>e.code==='budget_exceeded'&&e.message.includes('模型设置'));assert.equal(sends,1);
  const calls=relay.calls(auth,scope,job.operationId);assert.equal(calls[0].truncated,true);assert.equal(calls[0].status,'completed');assert.equal(calls[0].usage.outputTokens,256);assert.equal(calls[0].costUsd,null);
  const {executionModelUsage}=await import('../../public/model-usage.js');assert.match(executionModelUsage(calls,{status:'failed'},x=>x),/回复长度不足/);
 }finally{repository.close();rmSync(dir,{recursive:true,force:true});}
});
