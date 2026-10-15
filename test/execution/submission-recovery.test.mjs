import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createAgentHubExecutor} from '../../adapters/execution/agenthub.mjs';
import {SUBMISSION_PROTOCOL} from '../../adapters/execution/agenthub-submission.mjs';
import {sha256,payloadHash} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';

test('接收回执丢失后刷新，只按原提交核对身份并下载原文件；没有编号不重新执行',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-submission-'));
 const scope={projectId:'submission-recovery',versionId:null,branchId:null},workflowId=randomUUID(),taskId=randomUUID(),artifactId=randomUUID(),bytes=Buffer.from('# 原任务成果\n这是一份确定性协议夹具。');
 let repository=new WorkspaceRepository({dataDir:join(dir,'db')}),execution,app,received,posts=0,reads=0,proof='missing';
 const credential=repository.createCredential({ownerId:'fixture-owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','review_memory','prepare_task','execute','record_result']});
 let auth=repository.authenticate(credential.token);
 const tokenFile=join(dir,'token');writeFileSync(tokenFile,'fixture-only-not-a-key',{mode:0o600});
 const backend=createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer fixture-only-not-a-key');
  if(req.url==='/api/workflows/'+workflowId)return res.end(JSON.stringify({id:workflowId}));
  if(req.url==='/api/synplex/model-options')return res.end(JSON.stringify({protocol:'synplex.engine-selection/1',submissionLookup:SUBMISSION_PROTOCOL,choices:[{id:'fixture-model',provider:'fixture',efforts:['low']}]}));
  if(req.method==='POST'){
   assert.equal(req.url,'/api/synplex/executions');posts++;let text='';for await(const chunk of req)text+=chunk;received=JSON.parse(text);
   const {submission,...original}=received;assert.equal(submission.payload_hash,payloadHash(original));
   req.socket.destroy();return;
  }
  if(req.url.startsWith('/api/synplex/submissions/')){
   reads++;const url=new URL(req.url,'http://fixture'),{submission}=received;
   assert.equal(url.pathname,'/api/synplex/submissions/'+submission.operation_id);
   for(const field of ['attempt_id','packet_hash','payload_hash'])assert.equal(url.searchParams.get(field),submission[field]);
   if(proof==='missing'){res.writeHead(404);return res.end();}
   return res.end(JSON.stringify({protocol:SUBMISSION_PROTOCOL,...submission,...(proof==='wrong'?{attempt_id:randomUUID()}:{}),execution_id:taskId}));
  }
  if(req.url==='/api/executions/'+taskId)return res.end(JSON.stringify({id:taskId,workflow_id:workflowId,status:'completed',final_output:'原文件已生成',checkpoint_data:{}}));
  if(req.url==='/api/artifacts?execution_id='+taskId)return res.end(JSON.stringify([{id:artifactId,filename:'原成果.md',size:bytes.length,sha256:sha256(bytes),format:'md'}]));
  if(req.url==='/api/artifacts/'+artifactId+'/download')return res.end(bytes);
  res.writeHead(404);res.end();
 });await new Promise(yes=>backend.listen(0,'127.0.0.1',yes));
 const options={endpoint:'http://127.0.0.1:'+backend.address().port,tokenFile,workflowId,dataDir:join(dir,'journal'),provider:'fixture',model:'fixture-model',effort:'low',allowedModels:[{id:'fixture-model',efforts:['low']}]};
 const coordinator=()=>new ExecutionCoordinator({repository,adapters:{synplex:createAgentHubExecutor(options)}});
 execution=coordinator();t.after(async()=>{await app?.close();await execution.close();repository.close();await new Promise(yes=>backend.close(yes));rmSync(dir,{recursive:true,force:true});});
 const service=new WorkspaceService({repository,modules:{context}}),meta={protocolVersion:'synplex.workspace/1.0.0',scope,expectedStateRevision:0};
 const prepared=await service.call(auth,'prepare_task',{...meta,requestId:'prepare',goal:'生成说明文件',constraints:['保留原文'],acceptanceCriteria:['可下载'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:2000,executionOptions:{model:'fixture-model',effort:'low'}});
 const start={...meta,requestId:'start',runId:prepared.run.id},grant=repository.issueExecutionAuthorization(auth,start);
 const admitted=await execution.start(auth,{...start,authorizationId:grant.authorizationId});await execution.idle();
 assert.equal(posts,1);assert.equal(received.submission.operation_id,admitted.operation.id);
 assert.equal(repository.executionState(auth,scope,admitted.operation.id).operation.status,'unknown');
 assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,null);
 await execution.close();repository.close();repository=new WorkspaceRepository({dataDir:join(dir,'db')});auth=repository.authenticate(credential.token);execution=coordinator();
 app=createWorkspaceServer({repository,execution});const url=await app.listen();
 const reconcile=()=>fetch(url+'/api/v1/reconcile_execution',{method:'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:meta.protocolVersion,scope,operationId:admitted.operation.id})});
 assert.equal((await reconcile()).status,409);proof='wrong';assert.equal((await reconcile()).status,409);
 assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,null);
 proof='correct';repository.fault=({method})=>{if(method==='bind_remote_task')throw Error('fixture commit interrupted');};
 assert.equal((await reconcile()).status,409);assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,null);repository.fault=null;
 const response=await reconcile();assert.equal(response.status,200);const result=await response.json();
 assert.equal(result.operation.status,'succeeded');assert.equal(result.attempt.id,received.submission.attempt_id);
 assert.deepEqual(repository.artifactFile(auth,scope,result.results[0].id,artifactId).bytes,bytes);
 assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,taskId);
 assert.equal((await reconcile()).status,200);assert.equal(reads,4);assert.equal(posts,1);
 assert.equal(repository.list(auth,scope,'attempt').length,1);assert.equal(repository.usageLedger(auth,scope).totals.paidUsd,null);
 assert.equal(repository.list(auth,scope,'result_review').length,0);
});
