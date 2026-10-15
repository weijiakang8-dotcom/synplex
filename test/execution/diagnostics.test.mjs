import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync,writeFileSync,symlinkSync,statSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {request as httpRequest} from 'node:http';
import {setTimeout as delay} from 'node:timers/promises';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createDiagnosticLog} from '../../services/workspace/diagnostics.mjs';
import * as context from '../../packages/context/index.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
const scope={projectId:'diagnostic-fixture',versionId:null,branchId:null},protocolVersion='synplex.workspace/1.0.0';

test('关联日志只记安全元信息，任务状态来自真实持久记录，等答/未知/补存/停止及项目隔离不混淆',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-diagnostic-')),repository=new WorkspaceRepository({dataDir});
 const key=repository.createCredential({ownerId:'sensitive-owner-name',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','prepare_task','record_result','execute','review_memory']}),auth=repository.authenticate(key.token);
 const diagnostics=createDiagnosticLog(dataDir),app=createWorkspaceServer({repository,modules:{context},diagnostics}),url=await app.listen();
 t.after(async()=>{await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});});
 const post=(path,input={},token=key.token)=>fetch(url+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({protocolVersion,scope,...input})});
 const repo=await repository.forScope(auth,scope);await importSource(repo,{bytes:Buffer.from('决定：绝不能记入诊断的正文'),format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:'diagnostic-source',occurredAt:null,importOrigin:'isolated_test'},{requestId:'diagnostic-source',expectedStateRevision:0});
 const revision=repository.state(auth,scope).stateRevision;
 async function admit(){
  const expectedStateRevision=repository.state(auth,scope).stateRevision;
  const work=await app.service.call(auth,'prepare_task',{protocolVersion,scope,requestId:randomUUID(),expectedStateRevision,goal:'不可进入日志的原始目标',constraints:[],acceptanceCriteria:['保存真实状态'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:4000});
  const input={protocolVersion,scope,requestId:randomUUID(),expectedStateRevision,runId:work.run.id},grant=repository.issueExecutionAuthorization(auth,input);
  return repository.admitExecution(auth,{...input,authorizationId:grant.authorizationId});
 }
 const prepared=[await admit(),await admit()];
 assert.ok(repository.pendingOutbox(auth,scope).length>0);
 const before=repository.list(auth,scope,'operation'),summary=()=>repository.executionStatus(auth,scope);
 assert.equal(summary().counts.queued,2);assert.equal(summary().counts.total,2);assert.deepEqual(repository.list(auth,scope,'operation'),before,'读取状态不能认领或执行排队任务');
 const job=repository.claimExecution(auth,scope,prepared[0].operationId,60000);
 const question=repository.saveExecutionQuestion(auth,scope,job.operationId,job.claimId,{threadId:'private-thread',turnId:'private-turn',remoteRequestId:'17',itemId:'private-item',questions:[{id:'format',header:'格式',question:'需要什么格式？',isSecret:false,isOther:true,options:[{label:'文字',description:'可以编辑'}]}]},new Date(Date.now()+60000).toISOString());
 assert.equal(summary().counts.waiting,1);assert.equal(summary().counts.running,0);assert.equal(summary().counts.queued,1);assert.ok(summary().oldestWaitingAt);
 repository.answerExecutionQuestion(auth,{protocolVersion,scope,requestId:'answer-once',expectedStateRevision:revision,questionId:question.id,answers:{format:{answers:['文字']}}});
 assert.equal(summary().counts.answersUnconfirmed,1);assert.equal(summary().counts.waiting,0);
 repository.markExecutionUnknown(auth,scope,job.operationId,job.claimId);assert.equal(summary().counts.unknown,1);
 const result={eventId:'diagnostic-failure',attemptId:job.attemptId,provider:'isolated-fixture',summary:'失败信息不进请求日志',artifacts:[],checks:[],usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null};
 repository.saveExecutionReceipt(auth,scope,job.operationId,job.claimId,{status:'failed',result});assert.equal(summary().counts.writebackPending,1);assert.equal(summary().counts.answersUnconfirmed,0);
 repository.flushExecutionReceipt(auth,scope,job.operationId);assert.equal(summary().counts.writebackPending,0);assert.equal(summary().counts.failed,1);
 repository.requestExecutionCancellation(auth,scope,prepared[1].operationId);assert.equal(summary().counts.cancelled,1);
 const fresh=await admit(),stale=repository.claimExecution(auth,scope,fresh.operationId,10);assert.ok(stale);await delay(20);
 assert.equal(summary().counts.observationExpired,1);assert.equal(repository.operation(auth,scope,stale.operationId).status,'running','过期只是提醒，不能伪造宿主终态');
 repository.requestExecutionCancellation(auth,scope,stale.operationId);assert.equal(summary().counts.stopping,1);
 const response=await post('ui_history');assert.equal(response.status,200);const history=await response.json();assert.equal(history.executionStatus.counts.total,3);assert.equal(history.executionStatus.counts.observationExpired,1);assert.equal(history.diagnostics.available,true);
 const trace=response.headers.get('X-Synplex-Trace-Id');assert.match(trace,/^[a-f0-9-]{36}$/);
 const denied=await post('ui_history',{scope:{...scope,projectId:'private-other-project'}});assert.equal(denied.status,403);assert.equal((await denied.json()).executionStatus,undefined);
 const malformed=await fetch(url+'/api/v1/prepare_task?secret=never-log-query',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'},body:'invalid never-log-body'});assert.equal(malformed.status,400);
 await new Promise(resolve=>{
  const client=httpRequest(url+'/api/v1/prepare_task',{method:'POST',headers:{Authorization:'Bearer '+key.token,'Content-Type':'application/json'}});
  client.on('error',resolve);app.server.once('request',()=>setImmediate(()=>client.destroy()));client.write('never-log-aborted-body');
 });
 await delay(10);
 const log=readFileSync(join(dataDir,'diagnostics/requests.jsonl'),'utf8'),events=log.trim().split('\n').map(JSON.parse);
 assert.equal(events.find(e=>e.traceId===trace).status,200);assert.equal(events.find(e=>e.traceId===denied.headers.get('X-Synplex-Trace-Id')).errorCode,'scope_denied');assert.equal(events.find(e=>e.traceId===malformed.headers.get('X-Synplex-Trace-Id')).errorCode,'validation_failed');
 assert.ok(events.some(e=>e.outcome==='connection_closed'&&e.status===null),'断线不伪装成正常返回或成功');
 assert.ok(events.every(e=>Number.isFinite(e.durationMs)&&e.durationMs>=0));
 for(const secret of [key.token,'sensitive-owner-name','不可进入日志','绝不能记入','private-thread','private-other-project','never-log-query','never-log-body','never-log-aborted-body'])assert.ok(!log.includes(secret),secret);
 assert.equal(repository.list(auth,scope,'attempt').length,3);assert.equal(repository.list(auth,scope,'result').length,1);
});

test('诊断保留大小有限、重开不截断，日志路径替身和写入失败不会修改外部文件或拖垮业务',t=>{
 const root=mkdtempSync(join(tmpdir(),'synplex-log-retention-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const log=createDiagnosticLog(root,{maxBytes:1024});
 const event={format:'synplex.request-diagnostic/1',traceId:randomUUID(),recordedAt:new Date().toISOString(),route:'ui_history',status:200,durationMs:1};
 for(let i=0;i<20;i++)log.write(event);
 const files=readdirSync(join(root,'diagnostics'));assert.deepEqual(files.sort(),['requests.jsonl','requests.jsonl.1']);
 for(const file of files){const path=join(root,'diagnostics',file);assert.ok(statSync(path).size<=1024);assert.equal(statSync(path).mode&0o077,0);for(const line of readFileSync(path,'utf8').trim().split('\n'))assert.equal(JSON.parse(line).format,event.format);}
 const original=readFileSync(join(root,'diagnostics/requests.jsonl'),'utf8');assert.equal(createDiagnosticLog(root).status().available,true);assert.equal(readFileSync(join(root,'diagnostics/requests.jsonl'),'utf8'),original);
 const other=mkdtempSync(join(tmpdir(),'synplex-log-external-'));t.after(()=>rmSync(other,{recursive:true,force:true}));const target=join(other,'private-file');writeFileSync(target,'external bytes',{mode:0o600});
 rmSync(join(root,'diagnostics/requests.jsonl'));symlinkSync(target,join(root,'diagnostics/requests.jsonl'));log.write(event);assert.equal(log.status().available,false);assert.equal(readFileSync(target,'utf8'),'external bytes');
 const directoryRoot=mkdtempSync(join(tmpdir(),'synplex-log-link-'));t.after(()=>rmSync(directoryRoot,{recursive:true,force:true}));symlinkSync(other,join(directoryRoot,'diagnostics'));const unsafe=createDiagnosticLog(directoryRoot);assert.equal(unsafe.status().available,false);unsafe.write(event);assert.deepEqual(readdirSync(other),['private-file']);
});
