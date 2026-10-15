import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import { toolDefinitions } from '../../services/workspace/service.mjs';
import { PROTOCOL_VERSION, payloadHash, sha256 } from '../../packages/contracts/validate.mjs';

const scope={projectId:'fixture',versionId:'v2',branchId:null};
const caps=['read_memory','write_memory','prepare_task','record_result'];
const metadata=()=>({protocolVersion:PROTOCOL_VERSION,requestId:randomUUID(),scope,expectedStateRevision:0,format:'text/markdown',sourceSystem:'synthetic-test',formatVersion:'1',sessionId:null,eventId:randomUUID(),occurredAt:null});
// Deterministic synthetic test modules only. These are not deployed parsers or DSH module implementations.
function modules(counter={}) {
  return {
    ingestion:{async importSource(repo,input,meta){
      counter.imports=(counter.imports??0)+1;
      const source=(await repo.saveBlob({bytes:input.bytes,format:input.format},{...meta,requestId:`${meta.requestId}:blob`})).value;
      const text=Buffer.from(input.bytes).toString('utf8');
      const parsed=(await repo.appendParsedRevisions([{sourceId:source.id,parserVersion:'synthetic/1',normalizedTextHash:sha256(Buffer.from(text)),
        blocks:[{id:'block',text,rawStartByte:0,rawEndByte:input.bytes.length}],coverage:{status:'complete',coveredBytes:input.bytes.length,totalBytes:input.bytes.length,gaps:[]}}],
        {requestId:`${meta.requestId}:parsed`,expectedStateRevision:(await repo.getState()).stateRevision})).value[0];
      const occurrence=(await repo.appendOccurrences([{sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:input.sourceSystem,formatVersion:input.formatVersion,sessionId:input.sessionId,eventId:input.eventId,seq:null,importOrigin:input.importOrigin,occurredAt:input.occurredAt,payloadHash:sha256(input.bytes)}],
        {requestId:`${meta.requestId}:events`,expectedStateRevision:(await repo.getState()).stateRevision}));
      return {source,parsed,occurrences:occurrence.value,operationId:occurrence.operationId,warnings:[]};
    }},
    context:{async prepareContext(repo,input,options){
      counter.contexts=(counter.contexts??0)+1;
      const state=await repo.getState(),packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope:repo.scope,stateRevision:state.stateRevision,permissionRevision:state.permissionRevision,
        goal:input.goal,constraints:input.constraints,acceptanceCriteria:input.acceptanceCriteria,facts:state.facts,failures:state.failures,lessons:state.lessons,
        candidates:state.pending,conflicts:state.conflicts,unknowns:state.unknowns,evidence:[],selectedOccurrenceIds:input.selectedOccurrenceIds,coverage:'complete',
        budget:{maxInputTokens:input.maxInputTokens,reservedTokens:options.reservedTokens,estimatedTokens:100,estimatorVersion:options.estimatorVersion},createdAt:new Date().toISOString()};
      packet.contentHash=payloadHash(packet);return packet;
    }},
    experience:{async propose(repo,candidate,meta){return repo.appendCandidates([candidate],meta);}},
  };
}
async function setup(t,options={}) {
  const dataDir=mkdtempSync(join(tmpdir(),'synplex-http-')),repository=new WorkspaceRepository({dataDir});
  const ui=repository.createCredential({ownerId:'owner',actorId:'human',scope,capabilities:[...caps,'review_memory'],kind:'ui'});
  const host=repository.createCredential({ownerId:'owner',actorId:'host-a',scope,capabilities:caps,kind:'agent'});
  const readonly=repository.createCredential({ownerId:'owner',actorId:'reader',scope,capabilities:['read_memory'],kind:'agent'});
  const app=createWorkspaceServer({repository,...options}),url=await app.listen();
  t.after(async()=>{await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});});
  const post=(name,input,token=host.token,extra={})=>fetch(`${url}/api/v1/${name}`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`,...extra},body:JSON.stringify(input)});
  const upload=(input,text,token=ui.token)=>{const form=new FormData();form.set('metadata',JSON.stringify(input));form.set('source',new Blob([text]),'source.md');return fetch(`${url}/api/v1/import_source`,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:form});};
  return {dataDir,repository,app,url,ui,host,readonly,post,upload};
}
const prepareInput=()=>({protocolVersion:PROTOCOL_VERSION,requestId:randomUUID(),scope,expectedStateRevision:0,goal:'生成带证据的项目说明',constraints:['不读取密钥'],acceptanceCriteria:['保留失败过程'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:2000});

test('real HTTP authenticates reads and rejects cross-project, forged identity, bad Origin and DNS rebinding',async t=>{
  const {url,post,host}=await setup(t);
  assert.equal((await fetch(`${url}/health`)).status,200);
  assert.equal((await fetch(`${url}/api/v1/capabilities`)).status,403);
  const req={protocolVersion:PROTOCOL_VERSION,scope};assert.equal((await post('get_project_state',req)).status,200);
  assert.equal((await post('get_project_state',{...req,scope:{...scope,versionId:null}})).status,403);
  assert.equal((await post('get_project_state',{...req,ownerId:'someone'})).status,400);
  assert.equal((await post('get_project_state',req,host.token,{Origin:'https://malicious.example'})).status,403);
  const origin=new URL(url),status=await new Promise((resolve,reject)=>{const req=http.request({hostname:origin.hostname,port:origin.port,path:'/health',headers:{Host:'malicious.example'}},res=>{res.resume();resolve(res.statusCode)});req.on('error',reject);req.end();});
  assert.equal(status,403);
});

test('missing capabilities return actionable feedback, not fake prepare or discarded raw original',async t=>{
  const {post,upload,app}=await setup(t);
  const prep=await post('prepare_task',prepareInput());assert.equal(prep.status,503);
  const feedback=await prep.json();assert.equal(feedback.code,'capability_unavailable');assert.ok(feedback.nextAction);
  const input=metadata(),admission=await upload(input,'唯一原件，不能丢。');assert.ok([202,200].includes(admission.status));
  const body=await admission.json();await app.service.idle();
  const read=await post('get_import_result',{protocolVersion:PROTOCOL_VERSION,scope,operationId:body.operation.id});
  const finished=await read.json();assert.equal(finished.operation.status,'failed');assert.equal(finished.result.parsed,null);assert.ok(finished.result.source.sha256);
});

test('actual multipart binary upload reaches durable completion and exact replay never re-enters parser',async t=>{
  const counter={}, {post,upload,app,repository,ui}=await setup(t,{modules:modules(counter)}),input={...metadata(),sourceName:'检查样本.py'},text='正文含有 🧪、\r\n 和 boundary-like 字串。';
  const initial=await upload(input,text);const receipt=await initial.json();assert.ok([202,201].includes(initial.status));
  await app.service.idle();
  const read=await post('get_import_result',{protocolVersion:PROTOCOL_VERSION,scope,operationId:receipt.operation.id}),settled=await read.json();
  assert.equal(read.status,200);assert.equal(settled.result.outcome,'complete');assert.equal(settled.result.occurrences.length,1);
  const scoped=await repository.forScope(repository.authenticate(ui.token),scope);
  assert.equal(Buffer.from((await scoped.getBlob(settled.result.source.id)).bytes).toString(),text);
  const original=repository.selectedSourceFiles(repository.authenticate(ui.token),scope,{selectedOccurrenceIds:settled.result.occurrences.map(o=>o.id)});
  assert.equal(original[0].name,'检查样本.py');assert.equal(repository.sourceMetadata(repository.authenticate(ui.token),scope,settled.result.source.id).title,'检查样本.py');
  const before=(await scoped.getState()).stateRevision;
  const replay=await upload({...input,expectedStateRevision:999},text);assert.equal(replay.status,200);assert.equal((await replay.json()).operation.id,receipt.operation.id);
  for(let n=0;n<3;n++)await post('get_import_result',{protocolVersion:PROTOCOL_VERSION,scope,operationId:receipt.operation.id});
  assert.equal(counter.imports,1);assert.equal((await scoped.getState()).stateRevision,before);
  assert.equal((await upload(input,'different')).status,409);
  assert.equal((await upload({...input,sourceName:'changed.js'},text)).status,409);
  for(const sourceName of ['../private.py','x\\y.py','..','x\n.py'])assert.equal((await upload({...input,requestId:randomUUID(),sourceName},text)).status,400);
});

test('background processing is serial, unknown timeouts stop writes and reads never restart it',async t=>{
  let active=0,maxActive=0,calls=0;
  const fixture=modules();
  const custom={...fixture,ingestion:{async importSource(repo,input,meta){calls++;active++;maxActive=Math.max(maxActive,active);await new Promise(r=>setTimeout(r,20));try{return await fixture.ingestion.importSource(repo,input,meta);}finally{active--;}}}};
  const {upload,app,repository,ui,post}=await setup(t,{modules:custom});
  await upload(metadata(),'one');await upload(metadata(),'two');await app.service.idle();assert.equal(maxActive,1);assert.equal(calls,2);
  let finish;
  app.service.modules={ingestion:{async importSource(repo,input,meta){await new Promise(r=>finish=r);return repo.saveBlob({bytes:input.bytes,format:input.format},meta);}}};
  app.service.importTimeoutMs=15;
  const request={...metadata(),expectedStateRevision:4},receipt=await (await upload(request,'timeout')).json();await app.service.idle();
  const auth=repository.authenticate(ui.token);
  const unknown=await repository.importResult(auth,scope,receipt.operation.id);
  assert.equal(unknown.operation.status,'unknown');assert.equal(unknown.operation.error.retry,'lookup_operation');
  const stateBefore=repository.state(auth,scope).stateRevision;
  for(let n=0;n<3;n++)assert.equal((await (await post('get_import_result',{protocolVersion:PROTOCOL_VERSION,scope,operationId:receipt.operation.id})).json()).operation.status,'unknown');
  finish();await new Promise(r=>setTimeout(r,0));
  assert.equal(repository.state(auth,scope).stateRevision,stateBefore);
  assert.equal(receipt.operation.executionStatus,'not_started');
});

test('an interrupted running import reopens as unknown while queued work resumes exactly once',async t=>{
  const counter={}, {repository,ui,app}=await setup(t,{modules:modules(counter)}),auth=repository.authenticate(ui.token);
  const queued=repository.admitImport(auth,metadata(),Buffer.from('queued'));
  const running=repository.admitImport(auth,metadata(),Buffer.from('running'));
  repository.importProgress(auth,scope,running.operationId,'running');
  await app.service.recoverImports(auth,scope);await app.service.idle();
  assert.equal((await repository.importResult(auth,scope,queued.operationId)).result.outcome,'complete');
  const unknown=await repository.importResult(auth,scope,running.operationId);assert.equal(unknown.operation.status,'unknown');assert.equal(unknown.result,null);
  await app.service.recoverImports(auth,scope);await app.service.idle();assert.equal(counter.imports,1);
});

test('prepare replay uses original frozen packet without repeating context work; overlong goal is not truncated',async t=>{
  const counter={}, {post,readonly}=await setup(t,{modules:modules(counter)}),input=prepareInput();
  const first=await (await post('prepare_task',input)).json(),second=await (await post('prepare_task',{...input,expectedStateRevision:999})).json();
  assert.equal(first.packet.id,second.packet.id);assert.equal(first.run.id,second.run.id);assert.equal(counter.contexts,1);
  assert.equal((await post('prepare_task',{...input,requestId:'overlong',goal:'界'.repeat(16001)})).status,400);
  assert.equal((await post('prepare_task',{...input,requestId:'readonly'},readonly.token)).status,403);
  assert.equal((await post('prepare_task',{...input,requestId:'badmode',mode:'host_assist',executor:'codex'})).status,400);
});

test('six tool definitions compile independently and there is no execution or review MCP tool',()=>{
  const ajv=new Ajv2020({strict:true});addFormats(ajv);
  const tools=toolDefinitions();assert.equal(tools.length,6);
  for(const tool of tools)assert.equal(typeof ajv.compile(tool.inputSchema),'function');
  assert.equal(tools.some(x=>/execute|review|accept|import_source/.test(x.name)),false);
  assert.equal(tools[0].annotations.readOnlyHint,true);
});

test('HTTP caps reject oversized/invalid UTF-8 and duplicate multipart fields before admission',async t=>{
  const {url,host,ui,post,repository}=await setup(t,{modules:modules()});
  assert.equal((await post('get_project_state',{protocolVersion:PROTOCOL_VERSION,scope,padding:'x'.repeat(2*1024*1024)})).status,413);
  const bad=await fetch(`${url}/api/v1/get_project_state`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${host.token}`},body:Buffer.from([0xff,0x7b])});assert.equal(bad.status,400);
  const form=new FormData();form.append('metadata',JSON.stringify(metadata()));form.append('metadata',JSON.stringify(metadata()));form.set('source',new Blob(['original']),'x');
  assert.equal((await fetch(`${url}/api/v1/import_source`,{method:'POST',headers:{Authorization:`Bearer ${ui.token}`},body:form})).status,400);
  const scoped=await repository.forScope(repository.authenticate(ui.token),scope);assert.equal((await scoped.getState()).stateRevision,0);assert.equal(repository.list(repository.authenticate(ui.token),scope,'source').length,0);
});

test('read-only connection cannot import or review, and raw module exception details stay private',async t=>{
  const secret='SYNTHETIC_NOT_REAL_SECRET',broken={context:{async prepareContext(){throw new Error(`upstream token=${secret}`)}}};
  const {post,upload,readonly,host}=await setup(t,{modules:broken});
  const req=await post('prepare_task',prepareInput());assert.equal(req.status,409);assert.equal((await req.text()).includes(secret),false);
  assert.equal((await upload(metadata(),'raw',host.token)).status,403);
  assert.equal((await post('authorize_review',{protocolVersion:PROTOCOL_VERSION,scope,requestId:'x',expectedStateRevision:0,claimId:'x',reviewStatus:'confirmed'},readonly.token)).status,403);
});
