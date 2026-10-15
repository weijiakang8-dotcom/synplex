import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { RemoteSubmissionGuard } from '../../services/workspace/remote-submission.mjs';
import { PROTOCOL_VERSION, payloadHash } from '../../packages/contracts/validate.mjs';

const scope={projectId:'remote-guard-fixture',versionId:'v2',branchId:null};
const caps=['read_memory','prepare_task','execute'];
const targetKey=payloadHash('explicit-isolated-transport');
const isUnknown=e=>e.code==='conflict'&&e.retry==='lookup_operation';
function setup(t,{claim=true}={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'synplex-remote-'));
  const h={dataDir,repository:new WorkspaceRepository({dataDir})};
  const credential=h.repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:caps});
  const reauthenticate=()=>{h.auth=h.repository.authenticate(credential.token);};reauthenticate();
  const state=h.repository.state(h.auth,scope),request={protocolVersion:PROTOCOL_VERSION,scope,requestId:randomUUID(),
    expectedStateRevision:state.stateRevision,goal:'生成一个实际说明文件',constraints:['保留失败与出处'],acceptanceCriteria:['文件内容与目标一致'],
    mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:2000};
  const packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope,stateRevision:state.stateRevision,
    permissionRevision:state.permissionRevision,goal:request.goal,constraints:request.constraints,acceptanceCriteria:request.acceptanceCriteria,
    facts:[],failures:[],lessons:[],candidates:[],conflicts:[],unknowns:[],evidence:[],selectedOccurrenceIds:[],coverage:'complete',
    budget:{maxInputTokens:2000,reservedTokens:512,estimatedTokens:300,estimatorVersion:'synthetic-guard/1'},createdAt:new Date().toISOString()};
  packet.contentHash=payloadHash(packet);
  const prepared=h.repository.registerPrepared(h.auth,request,packet).value;
  const grantRequest={protocolVersion:PROTOCOL_VERSION,scope,requestId:randomUUID(),expectedStateRevision:state.stateRevision,runId:prepared.run.id};
  const {authorizationId}=h.repository.issueExecutionAuthorization(h.auth,grantRequest);
  const admitted=h.repository.admitExecution(h.auth,{...grantRequest,authorizationId});
  if(claim)h.repository.claimExecution(h.auth,scope,admitted.operationId,300_000);
  h.args={operationId:admitted.operationId,attemptId:admitted.value.attempt.id,packet,payload:{prompt:JSON.stringify(packet)}};
  h.guard=(transport,extra={})=>new RemoteSubmissionGuard({repository:h.repository,auth:h.auth,scope,targetKey,transport,...extra});
  h.reopen=()=>{h.repository.close();h.repository=new WorkspaceRepository({dataDir});reauthenticate();};
  t.after(()=>{h.repository.close();rmSync(dataDir,{recursive:true,force:true});});
  return h;
}

test('real HTTP submission persists task identity; reopening only GETs the same remote task',async t=>{
  const h=setup(t);let posts=0,reads=0,sent;
  const server=createServer(async(req,res)=>{
    if(req.method==='POST'){posts++;let text='';for await(const b of req)text+=b;sent=JSON.parse(text);res.end(JSON.stringify({taskId:'remote-1'}));}
    else {reads++;res.end(JSON.stringify({taskId:'remote-1',status:'completed'}));}
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>server.close(r)));
  const url=`http://127.0.0.1:${server.address().port}`;
  const transport={submit:async args=>(await fetch(`${url}/tasks`,{method:'POST',body:JSON.stringify(args.payload)})).json(),
    lookup:async({taskId})=>(await fetch(`${url}/tasks/${taskId}`)).json()};
  const first=await h.guard(transport).submitOrLookup(h.args);assert.equal(first.taskId,'remote-1');
  assert.deepEqual(JSON.parse(sent.prompt),h.args.packet);h.reopen();
  const second=await h.guard(transport).submitOrLookup(h.args);assert.deepEqual(second,first);
  assert.equal(posts,1);assert.equal(reads,2);assert.equal(h.repository.list(h.auth,scope,'attempt').length,1);
  assert.equal(h.repository.state(h.auth,scope).stateRevision,0);
});

test('remote acceptance with a lost response survives restart without a second submission',async t=>{
  const h=setup(t);let accepted=0,lookups=0;
  const transport={submit:async()=>{accepted++;throw new Error('response lost; SYNTHETIC_PRIVATE_TOKEN');},lookup:async()=>{lookups++;}};
  await assert.rejects(h.guard(transport).submitOrLookup(h.args),e=>isUnknown(e)&&!e.message.includes('PRIVATE_TOKEN'));
  h.reopen();await assert.rejects(h.guard(transport).submitOrLookup(h.args),isUnknown);
  assert.equal(accepted,1);assert.equal(lookups,0);
  const persisted=h.repository.list(h.auth,scope,'remote_submission');assert.equal(persisted.length,1);assert.equal(persisted[0].taskId,null);
});

test('a crash between reservation and sending does not turn an unknown intent into a new POST',async t=>{
  const h=setup(t);const {operationId,attemptId,packet,payload}=h.args;
  h.repository.reserveRemoteSubmission(h.auth,scope,operationId,attemptId,{packetHash:packet.contentHash,payloadHash:payloadHash(payload),targetKey});
  h.reopen();let calls=0;const transport={submit:async()=>{calls++;},lookup:async()=>{calls++;}};
  await assert.rejects(h.guard(transport).submitOrLookup(h.args),isUnknown);assert.equal(calls,0);
});

test('two SQLite connections cannot reserve or submit the same remote operation twice',async t=>{
  const h=setup(t),second=new WorkspaceRepository({dataDir:h.dataDir});t.after(()=>second.close());
  const credential=second.createCredential({ownerId:'owner',actorId:'second',scope,kind:'ui',capabilities:caps});
  let release,calls=0;const held=new Promise(r=>release=r);
  const transport={submit:async()=>{calls++;await held;return {taskId:'remote-concurrent'};},lookup:async({taskId})=>({taskId})};
  const running=h.guard(transport).submitOrLookup(h.args);
  const guard=new RemoteSubmissionGuard({repository:second,auth:second.authenticate(credential.token),scope,targetKey,transport});
  try{await assert.rejects(guard.submitOrLookup(h.args),isUnknown);assert.equal(calls,1);}
  finally{release();}
  assert.equal((await running).taskId,'remote-concurrent');
});

test('changed connection/payload/packet, forged attempt and queued work never dispatch',async t=>{
  const h=setup(t);let calls=0;const transport={submit:async()=>{calls++;return {taskId:'remote-bound'};},lookup:async({taskId})=>({taskId})};
  await h.guard(transport).submitOrLookup(h.args);
  await assert.rejects(h.guard(transport,{targetKey:payloadHash('other-endpoint')}).submitOrLookup(h.args),isUnknown);
  await assert.rejects(h.guard(transport).submitOrLookup({...h.args,payload:{prompt:'replace requirements'}}),isUnknown);
  await assert.rejects(h.guard(transport).submitOrLookup({...h.args,packet:{...h.args.packet,goal:'replace goal'}}),isUnknown);
  await assert.rejects(h.guard(transport).submitOrLookup({...h.args,attemptId:'forged'}),e=>e.code==='scope_denied');
  const queued=setup(t,{claim:false});await assert.rejects(queued.guard(transport).submitOrLookup(queued.args),isUnknown);
  assert.equal(calls,1);
});

test('aborted preflight and rollback make no submission; stored identity is immutable and permissions are rechecked',async t=>{
  const h=setup(t);let calls=0;const transport={submit:async()=>{calls++;return {taskId:'remote-one'};},lookup:async({taskId})=>({taskId})};
  await assert.rejects(h.guard(transport).submitOrLookup({...h.args,signal:AbortSignal.abort()}),isUnknown);
  assert.equal(h.repository.list(h.auth,scope,'remote_submission').length,0);
  h.repository.fault=({method})=>{if(method==='reserve_remote_submission')throw new Error('commit-crash');};
  await assert.rejects(h.guard(transport).submitOrLookup(h.args),/commit-crash/);assert.equal(calls,0);
  assert.equal(h.repository.list(h.auth,scope,'remote_submission').length,0);h.repository.fault=null;
  await h.guard(transport).submitOrLookup(h.args);
  assert.throws(()=>h.repository.bindRemoteTask(h.auth,scope,h.args.operationId,h.args.attemptId,'different'),isUnknown);
  const reader=h.repository.createCredential({ownerId:'owner',actorId:'reader',scope,capabilities:['read_memory'],kind:'ui'});
  await assert.rejects(h.guard(transport,{auth:h.repository.authenticate(reader.token)}).submitOrLookup(h.args),e=>e.code==='scope_denied');
  const foreign={...scope,projectId:'foreign'};
  await assert.rejects(h.guard(transport,{scope:foreign}).submitOrLookup(h.args),e=>e.code==='scope_denied');
  assert.equal(calls,1);
});

test('lost identity persistence or a mismatched lookup remains unknown and never retries submit',async t=>{
  const h=setup(t);let calls=0;
  const transport={submit:async()=>{calls++;return {taskId:'known'};},lookup:async()=>({taskId:'wrong'})};
  await assert.rejects(h.guard(transport).submitOrLookup(h.args),isUnknown);h.reopen();
  await assert.rejects(h.guard(transport).submitOrLookup(h.args),isUnknown);assert.equal(calls,1);
  const crashed=setup(t);let accepted=0,reads=0;
  const another={submit:async()=>{accepted++;return {taskId:'accepted-before-crash'};},lookup:async()=>{reads++;}};
  crashed.repository.fault=({method})=>{if(method==='bind_remote_task')throw new Error('identity-commit-crash');};
  await assert.rejects(crashed.guard(another).submitOrLookup(crashed.args),isUnknown);
  crashed.reopen();await assert.rejects(crashed.guard(another).submitOrLookup(crashed.args),isUnknown);
  assert.equal(accepted,1);assert.equal(reads,0);
});
