import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {PROTOCOL_VERSION,payloadHash} from '../../packages/contracts/validate.mjs';

const scope={projectId:'isolated-execution',versionId:'v2',branchId:null};
const caps=['read_memory','write_memory','prepare_task','record_result','execute'];
const unknownUsage={observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'};
const is=code=>e=>e.code===code;
function setup(t,executionLimits){
  const dataDir=mkdtempSync(join(tmpdir(),'synplex-execute-'));
  let repository=new WorkspaceRepository({dataDir,executionLimits});
  const human=repository.createCredential({ownerId:'owner',actorId:'human',scope,capabilities:[...caps,'review_memory'],kind:'ui'});
  t.after(()=>{repository.close();rmSync(dataDir,{recursive:true,force:true});});
  return {dataDir,human,get repository(){return repository;},get auth(){return repository.authenticate(human.token);},
    reopen(){repository.close();repository=new WorkspaceRepository({dataDir,executionLimits});return repository;}};
}
function prepare(s,extra={}){
  const state=s.repository.state(s.auth,scope),request={protocolVersion:PROTOCOL_VERSION,requestId:randomUUID(),scope,expectedStateRevision:state.stateRevision,
    goal:'交付项目说明',constraints:['不外发资料'],acceptanceCriteria:['保留失败与转折'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:2000,...extra};
  const packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope,stateRevision:state.stateRevision,permissionRevision:state.permissionRevision,
    goal:request.goal,constraints:request.constraints,acceptanceCriteria:request.acceptanceCriteria,facts:[],failures:[],lessons:[],candidates:[],conflicts:[],unknowns:[],
    evidence:[],selectedOccurrenceIds:[],coverage:'complete',budget:{maxInputTokens:2000,reservedTokens:100,estimatedTokens:300,estimatorVersion:'synthetic/1'},createdAt:new Date().toISOString()};
  packet.contentHash=payloadHash(packet);
  return s.repository.registerPrepared(s.auth,request,packet).value;
}
function authorize(s,run){
  const input={protocolVersion:PROTOCOL_VERSION,scope,requestId:randomUUID(),expectedStateRevision:s.repository.state(s.auth,scope).stateRevision,runId:run.id};
  return {...input,...s.repository.issueExecutionAuthorization(s.auth,input)};
}
function request(input){const {expiresAt,...value}=input;return value;}
function receipt(attemptId,status='succeeded',summary='已保存文件'){
  return {status,result:{eventId:randomUUID(),attemptId,provider:'synthetic-local-test',summary,
    artifacts:[],checks:[],usage:unknownUsage,supersedesResultId:null,occurredAt:null}};
}
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};}
test('budget holds commit once, refund only unsent work and block unknown or increased paid costs before dispatch',t=>{
 const s=setup(t,{totalUsd:0.3,dailyUsd:0.2,reservationUsd:0.1,maximumUnknownCharges:1,timezone:'Asia/Shanghai',startsAt:'1970-01-01T00:00:00Z'});
 const runs=[prepare(s).run,prepare(s).run,prepare(s).run],requests=runs.map(r=>request(authorize(s,r)));
 const one=s.repository.admitExecution(s.auth,requests[0]);s.repository.admitExecution(s.auth,requests[0]);
 const two=s.repository.admitExecution(s.auth,requests[1]);
 assert.equal(s.repository.list(s.auth,scope,'budget_hold').length,2);
 assert.throws(()=>s.repository.admitExecution(s.auth,requests[2]),{code:'budget_exceeded'});
 assert.equal(s.repository.list(s.auth,scope,'attempt').length,2,'rejected authorization leaves no partial attempt');
 s.repository.requestExecutionCancellation(s.auth,scope,one.operationId);
 const three=s.repository.admitExecution(s.auth,requests[2]);assert.equal(s.repository.budgetStatus(s.auth,scope).dailyCommittedUsd,0.2);
 const claimed=s.repository.claimExecution(s.auth,scope,two.operationId);
 assert.ok(claimed);s.repository.saveExecutionReceipt(s.auth,scope,two.operationId,claimed.claimId,receipt(claimed.attemptId,'failed'));
 s.repository.flushExecutionReceipt(s.auth,scope,two.operationId);
 assert.equal(s.repository.claimExecution(s.auth,scope,three.operationId),null,'unknown failed charge cannot authorize more paid work');
 assert.equal(s.repository.operation(s.auth,scope,three.operationId).error.code,'budget_exceeded');
 const invoice={protocolVersion:PROTOCOL_VERSION,scope,requestId:'budget-invoice',expectedStateRevision:s.repository.state(s.auth,scope).stateRevision,attemptId:claimed.attemptId,costUsd:0.12,receiptReference:'fixture:line-1',supersedesId:null};
 s.repository.reconcileUsage(s.auth,invoice);s.reopen();
 assert.equal(s.repository.claimExecution(s.auth,scope,three.operationId),null,'already queued work rechecks actual cost after recovery');
 const old=s.repository.list(s.auth,scope,'usage_reconciliation')[0];
 s.repository.reconcileUsage(s.auth,{...invoice,requestId:'correct-budget-invoice',costUsd:0.03,supersedesId:old.id});
 assert.equal(s.repository.claimExecution(s.auth,scope,three.operationId),null);
 assert.equal(s.repository.operation(s.auth,scope,three.operationId).error.code,'stale_context','cost correction cannot bypass changed background');
 const fresh=request(authorize(s,prepare(s).run)),four=s.repository.admitExecution(s.auth,fresh);
 assert.ok(s.repository.claimExecution(s.auth,scope,four.operationId));
 assert.equal(s.repository.list(s.auth,scope,'budget_hold').length,4,'cancellation and corrections preserve all history');
});
async function changed(s){const repo=await s.repository.forScope(s.auth,scope);return repo.appendCandidates([{type:'unknown',title:'新增缺口',body:'资料缺失',evidenceKind:'user_statement',evidence:[],occurredAt:null,supersedes:[],condition:null}],{requestId:randomUUID(),expectedStateRevision:(await repo.getState()).stateRevision});}

test('execution requires a separate human grant; host assistance and forged grants cannot launch an agent',t=>{
  const s=setup(t),prepared=prepare(s),input=authorize(s,prepared.run);
  assert.throws(()=>s.repository.admitExecution(s.auth,{...request(input),authorizationId:'model-says-approved'}),is('scope_denied'));
  const host=s.repository.createCredential({ownerId:'owner',actorId:'host',scope,capabilities:caps,kind:'agent'});
  assert.throws(()=>s.repository.issueExecutionAuthorization(s.repository.authenticate(host.token),{protocolVersion:PROTOCOL_VERSION,scope,requestId:'host',expectedStateRevision:0,runId:prepared.run.id}),is('scope_denied'));
  const hostRun=prepare(s,{mode:'host_assist',executor:'current_host'}).run;
  assert.throws(()=>authorize(s,hostRun),is('scope_denied'));
  assert.throws(()=>s.repository.admitExecution(s.auth,{...request(input),endpoint:'http://untrusted'}),is('validation_failed'));
  assert.equal(s.repository.list(s.auth,scope,'execution_job').length,0);
});

test('grant binds actor, run, revision and request; admission and grant consumption roll back together',t=>{
  const s=setup(t),run=prepare(s).run,otherRun=prepare(s).run,input=request(authorize(s,run));
  assert.throws(()=>s.repository.admitExecution(s.auth,{...input,runId:otherRun.id}),is('scope_denied'));
  assert.throws(()=>s.repository.admitExecution(s.auth,{...input,requestId:'another'}),is('scope_denied'));
  const other=s.repository.createCredential({ownerId:'owner',actorId:'other-human',scope,capabilities:caps,kind:'ui'});
  assert.throws(()=>s.repository.admitExecution(s.repository.authenticate(other.token),input),is('scope_denied'));
  s.repository.fault=({method})=>{if(method==='execute_task')throw new Error('transaction-crash');};
  assert.throws(()=>s.repository.admitExecution(s.auth,input),/transaction-crash/);
  assert.equal(s.repository.read(s.auth,scope,'run',run.id).status,'prepared');assert.equal(s.repository.list(s.auth,scope,'execution_job').length,0);
  s.repository.fault=null;assert.equal(s.repository.admitExecution(s.auth,input).value.run.status,'queued');
});

test('durable admission replay and repeated reads preserve one attempt without dispatching',t=>{
  const s=setup(t),run=prepare(s).run,input=request(authorize(s,run)),one=s.repository.admitExecution(s.auth,input);
  s.reopen();const two=s.repository.admitExecution(s.auth,{...input,expectedStateRevision:999});
  assert.equal(two.operationId,one.operationId);assert.equal(two.duplicate,true);
  for(let i=0;i<3;i++)assert.equal(s.repository.executionState(s.auth,scope,one.operationId).attempt.status,'queued');
  assert.equal(s.repository.list(s.auth,scope,'attempt').length,1);
  assert.throws(()=>s.repository.admitExecution(s.auth,{...input,authorizationId:'different'}),is('conflict'));
  assert.throws(()=>s.repository.executionState(s.auth,{...scope,projectId:'wrong'},one.operationId),is('scope_denied'));
  assert.equal(s.repository.state(s.auth,scope).stateRevision,0);
});

test('a second pre-issued human grant cannot create a second attempt for the same run',t=>{
  const s=setup(t),run=prepare(s).run,a=request(authorize(s,run)),b=request(authorize(s,run));
  s.repository.admitExecution(s.auth,a);
  assert.throws(()=>s.repository.admitExecution(s.auth,b),is('conflict'));
  assert.equal(s.repository.list(s.auth,scope,'attempt').length,1);
  assert.equal(s.repository.list(s.auth,scope,'execution_job').length,1);
});

test('two real independent processes claim one dispatch owner, including after a process has exited',async t=>{
  const s=setup(t),run=prepare(s).run,admitted=s.repository.admitExecution(s.auth,request(authorize(s,run)));
  const code=`import {WorkspaceRepository} from ${JSON.stringify(new URL('../../services/workspace/repository.mjs',import.meta.url).href)};
let text='';for await(const b of process.stdin)text+=b;const i=JSON.parse(text);const r=new WorkspaceRepository({dataDir:i.dataDir});
try{console.log(JSON.stringify(r.claimExecution(r.authenticate(i.token),i.scope,i.id)))}finally{r.close()}`;
  const invoke=()=>new Promise((resolve,reject)=>{const child=spawn(process.execPath,['--input-type=module','-e',code],{stdio:['pipe','pipe','pipe']});let out='',err='';
    child.stdout.on('data',b=>out+=b);child.stderr.on('data',b=>err+=b);child.on('error',reject);child.on('exit',status=>status===0?resolve(JSON.parse(out)):reject(new Error(err)));
    child.stdin.end(JSON.stringify({dataDir:s.dataDir,token:s.human.token,scope,id:admitted.operationId}));});
  const results=await Promise.all([invoke(),invoke()]);assert.equal(results.filter(Boolean).length,1);
  assert.equal(s.repository.claimExecution(s.auth,scope,admitted.operationId),null);
});

test('queued cancellation never executes; in-flight cancel intent is not a fabricated cancellation receipt',async t=>{
  const s=setup(t),run=prepare(s).run,id=s.repository.admitExecution(s.auth,request(authorize(s,run))).operationId;
  s.repository.requestExecutionCancellation(s.auth,scope,id);
  assert.equal(s.repository.claimExecution(s.auth,scope,id),null);assert.equal(s.repository.executionState(s.auth,scope,id).operation.executionStatus,'not_started');
  const started=deferred(),done=deferred();let cancels=0;
  const executor=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(i){started.resolve(i);return done.promise;},async cancel(){cancels++;}}}});
  const next=await executor.start(s.auth,request(authorize(s,prepare(s).run))),input=await started.promise;
  const cancel=await executor.cancel(s.auth,scope,next.operation.id);assert.equal(cancel.operation.executionStatus,'running');assert.equal(cancel.cancelRequested,true);
  await executor.cancel(s.auth,scope,next.operation.id);assert.equal(cancels,1);
  done.resolve(receipt(input.attemptId,'cancelled'));await executor.idle();assert.equal(s.repository.executionState(s.auth,scope,next.operation.id).run.status,'cancelled');
});

test('new project facts invalidate queued context before any adapter call',async t=>{
  const s=setup(t),run=prepare(s).run,input=request(authorize(s,run)),id=s.repository.admitExecution(s.auth,input).operationId;
  await changed(s);assert.equal(s.repository.claimExecution(s.auth,scope,id),null);
  const state=s.repository.executionState(s.auth,scope,id);assert.equal(state.run.status,'needs_input');assert.equal(state.operation.executionStatus,'not_started');
  assert.equal(state.operation.error.code,'stale_context');assert.equal(s.repository.claimExecution(s.auth,scope,id),null);
});

test('revoked permission blocks dispatch and a prepared authorization cannot bypass the new permission revision',t=>{
  const s=setup(t),run=prepare(s).run,input=request(authorize(s,run)),auth=s.auth;
  s.repository.revokeCredential(s.human.id);
  assert.throws(()=>s.repository.admitExecution(auth,input),is('scope_denied'));
  const next=s.repository.createCredential({ownerId:'owner',actorId:'human',scope,capabilities:caps,kind:'ui'});
  assert.throws(()=>s.repository.admitExecution(s.repository.authenticate(next.token),input),is('stale_context'));
});

test('expired running lease is unknown after reopening, never automatically dispatched again',async t=>{
  const s=setup(t),run=prepare(s).run,id=s.repository.admitExecution(s.auth,request(authorize(s,run))).operationId;
  s.repository.claimExecution(s.auth,scope,id,10);await new Promise(r=>setTimeout(r,25));s.reopen();
  let calls=0;const coordinator=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(){calls++;}}}});
  await coordinator.recover(s.auth,scope);await coordinator.recover(s.auth,scope);
  const state=s.repository.executionState(s.auth,scope,id);assert.equal(state.operation.status,'unknown');assert.equal(state.operation.error.retry,'lookup_operation');
  assert.equal(calls,0);assert.equal(s.repository.claimExecution(s.auth,scope,id),null);
});

test('recovery does not mark another live lease unknown or automatically send queued work',async t=>{
  const s=setup(t),run=prepare(s).run,id=s.repository.admitExecution(s.auth,request(authorize(s,run))).operationId;
  const second=s.repository.admitExecution(s.auth,request(authorize(s,prepare(s).run))).operationId;
  s.repository.claimExecution(s.auth,scope,id);let calls=0;
  const coordinator=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(){calls++;}}}});
  await coordinator.recover(s.auth,scope);assert.equal(s.repository.executionState(s.auth,scope,id).operation.status,'running');
  assert.equal(s.repository.executionState(s.auth,scope,second).operation.status,'queued');assert.equal(calls,0);
});

test('explicit restart resumes only a persisted unsent intent, using the original dispatch identity',async t=>{
  const s=setup(t),input=request(authorize(s,prepare(s).run)),admission=s.repository.admitExecution(s.auth,input);
  s.reopen();let calls=0,dispatch;
  const coordinator=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(i){calls++;dispatch=i;return receipt(i.attemptId);}}}});
  await coordinator.recover(s.auth,scope);assert.equal(calls,0);
  const resumed=await coordinator.start(s.auth,input);await coordinator.idle();
  assert.equal(resumed.operation.id,admission.operationId);assert.equal(dispatch.idempotencyKey,admission.operationId);
  assert.equal(s.repository.executionState(s.auth,scope,admission.operationId).results.length,1);assert.equal(calls,1);
});

test('a durable completed receipt survives failed writeback; recovery retries only the transaction, once',async t=>{
  const s=setup(t),run=prepare(s).run,input=request(authorize(s,run));let calls=0;
  s.repository.fault=({method})=>{if(method==='flush_execution_receipt')throw new Error('writeback-crash');};
  const coordinator=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(i){calls++;return receipt(i.attemptId);}}}});
  const reply=await coordinator.start(s.auth,input);await coordinator.idle();
  let state=s.repository.executionState(s.auth,scope,reply.operation.id);assert.equal(state.operation.executionStatus,'succeeded');assert.equal(state.operation.writebackStatus,'pending');
  assert.equal(state.operation.error.retry,'writeback_only');assert.equal(state.results.length,0);assert.equal(s.repository.state(s.auth,scope).stateRevision,0);
  const pending=s.repository.pendingOutbox(s.auth,scope).find(x=>x.kind==='execution_writeback');
  assert.equal(s.repository.acknowledgeOutbox(s.auth,scope,pending.id),0);
  assert.equal(s.repository.pendingOutbox(s.auth,scope).some(x=>x.id===pending.id),true);
  s.reopen();const recovered=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(){calls++;}}}});
  await recovered.recover(s.auth,scope);await recovered.recover(s.auth,scope);
  state=s.repository.executionState(s.auth,scope,reply.operation.id);assert.equal(state.results.length,1);assert.equal(state.operation.writebackStatus,'saved');
  assert.equal(state.results[0].trust,'platform_receipt');assert.equal(state.attempt.usage.costUsd,null);assert.equal(calls,1);assert.equal(s.repository.state(s.auth,scope).stateRevision,1);
  assert.equal((await recovered.start(s.auth,{...input,expectedStateRevision:999})).operation.id,reply.operation.id);assert.equal(calls,1);
});

test('conflicting direct receipts do not erase an earlier failed attempt or become independent business acceptance',t=>{
  const s=setup(t),run=prepare(s).run,id=s.repository.admitExecution(s.auth,request(authorize(s,run))).operationId;
  const claim=s.repository.claimExecution(s.auth,scope,id),failed=receipt(claim.attemptId,'failed','工具失败，已有文件保留');
  s.repository.saveExecutionReceipt(s.auth,scope,id,claim.claimId,failed);s.repository.flushExecutionReceipt(s.auth,scope,id);
  assert.throws(()=>s.repository.saveExecutionReceipt(s.auth,scope,id,claim.claimId,receipt(claim.attemptId)),is('conflict'));
  const state=s.repository.executionState(s.auth,scope,id);assert.equal(state.results.length,1);assert.equal(state.results[0].summary,failed.result.summary);
  assert.equal(state.results[0].trust,'platform_receipt');assert.equal(s.repository.state(s.auth,scope).facts.length,0);
  assert.throws(()=>s.repository.saveExecutionReceipt(s.auth,scope,id,'forged',failed),is('scope_denied'));
});

test('network timeout is unknown, no hidden retry, and a later real receipt can finish the same attempt',async t=>{
  const s=setup(t),done=deferred();let calls=0,input;
  const coordinator=new ExecutionCoordinator({repository:s.repository,timeoutMs:15,leaseMs:90,adapters:{synplex:{mode:'platform_owned',async execute(i){calls++;input=i;return done.promise;}}}});
  const requestInput=request(authorize(s,prepare(s).run)),reply=await coordinator.start(s.auth,requestInput);await coordinator.idle();
  assert.equal(s.repository.executionState(s.auth,scope,reply.operation.id).operation.executionStatus,'unknown');assert.equal(input.signal.aborted,true);
  await coordinator.start(s.auth,requestInput);assert.equal(calls,1);
  done.resolve(receipt(input.attemptId));await new Promise(r=>setTimeout(r,5));
  const state=s.repository.executionState(s.auth,scope,reply.operation.id);assert.equal(state.operation.executionStatus,'succeeded');assert.equal(state.results.length,1);assert.equal(calls,1);
});

test('unsupported executor and transport errors preserve work and report capability or unknown, not fake success',async t=>{
  const s=setup(t),run=prepare(s).run,input=request(authorize(s,run)),missing=new ExecutionCoordinator({repository:s.repository});
  await assert.rejects(missing.start(s.auth,input),is('capability_unavailable'));assert.equal(s.repository.read(s.auth,scope,'run',run.id).status,'prepared');
  let calls=0;const broken=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'platform_owned',async execute(){calls++;throw new Error('upstream secret');}}}});
  const reply=await broken.start(s.auth,input);await broken.idle();const state=s.repository.executionState(s.auth,scope,reply.operation.id);
  assert.equal(state.operation.status,'unknown');assert.equal(JSON.stringify(state).includes('upstream secret'),false);assert.equal(calls,1);assert.equal(state.results.length,0);
});

test('configured adapter cannot silently change the run mode and two services replay one completed work',async t=>{
  const s=setup(t),input=request(authorize(s,prepare(s).run));let calls=0;
  const wrong=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:{mode:'delegated',async execute(){calls++;}}}});
  await assert.rejects(wrong.start(s.auth,input),is('capability_unavailable'));assert.equal(calls,0);
  const adapter={mode:'platform_owned',async execute(i){calls++;return receipt(i.attemptId);}},a=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:adapter}}),b=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:adapter}});
  const results=await Promise.all([a.start(s.auth,input),b.start(s.auth,input)]);await a.idle();await b.idle();
  assert.equal(results[0].operation.id,results[1].operation.id);assert.equal(calls,1);
});


test('timeout blocks all later dispatches until a real terminal receipt, including after restart',async t=>{
  const s=setup(t),done=deferred();let calls=0,firstInput;
  const adapter={mode:'platform_owned',async execute(i){calls++;if(!firstInput){firstInput=i;return done.promise;}return receipt(i.attemptId);}};
  const coordinator=new ExecutionCoordinator({repository:s.repository,timeoutMs:15,leaseMs:90,adapters:{synplex:adapter}});
  const first=await coordinator.start(s.auth,request(authorize(s,prepare(s).run)));
  await coordinator.idle();assert.equal(s.repository.executionState(s.auth,scope,first.operation.id).operation.status,'unknown');
  const nextInput=request(authorize(s,prepare(s).run)),second=await coordinator.start(s.auth,nextInput);
  await coordinator.idle();assert.equal(calls,1);
  assert.equal(s.repository.executionState(s.auth,scope,second.operation.id).operation.status,'queued');
  assert.match(s.repository.executionState(s.auth,scope,second.operation.id).operation.error.message,/还没发送/);
  const recovered=new ExecutionCoordinator({repository:s.repository,adapters:{synplex:adapter}});
  await recovered.recover(s.auth,scope);await recovered.start(s.auth,nextInput);await recovered.idle();assert.equal(calls,1);
  done.resolve(receipt(firstInput.attemptId));await new Promise(r=>setTimeout(r,10));
  // Late writeback updates the project. Refreshing the background is required,
  // rather than silently running stale queued work after that update.
  await recovered.start(s.auth,nextInput);await recovered.idle();
  assert.equal(s.repository.executionState(s.auth,scope,second.operation.id).run.status,'needs_input');assert.equal(calls,1);
  const third=await recovered.start(s.auth,request(authorize(s,prepare(s).run)));await recovered.idle();
  assert.equal(calls,2);assert.equal(s.repository.executionState(s.auth,scope,third.operation.id).operation.status,'succeeded');
});
