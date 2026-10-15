// The engine in this check is the actual private FastAPI process, not a mock.
// A loopback transport drops ONLY its accepted POST acknowledgement. No worker
// runs during admission; this verifies identity recovery, not task completion.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {DatabaseSync} from 'node:sqlite';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createAgentHubExecutor} from '../../adapters/execution/agenthub.mjs';
import * as context from '../../packages/context/index.mjs';

const [directory,settingsFile]=process.argv.slice(2),config=JSON.parse(readFileSync(settingsFile));
const resume=process.argv[4]==='--resume-lookup';
const scope={projectId:'real-api-submission-check',versionId:null,branchId:null};
let posts=0,acceptedTaskId,repository,execution,app;
let original,proxyPort=0;
if(resume){
 const db=new DatabaseSync(join(directory,'workspace/workspace.sqlite'),{readOnly:true});
 try{
  const remote=JSON.parse(db.prepare("SELECT body_json FROM records WHERE kind='remote_submission'").get().body_json);
  original={operation:{id:remote.id},attempt:{id:remote.attemptId}};
  proxyPort=JSON.parse(readFileSync(join(directory,'proxy-settings.json'))).port;
  assert.ok(proxyPort,'Original test transport identity must be preserved');
  assert.equal(payloadHash({endpoint:'http://127.0.0.1:'+proxyPort,workflowId:config.workflowId,tokenFile:config.tokenFile}),remote.binding.targetKey);
  ({posts,acceptedTaskId}=JSON.parse(readFileSync(join(directory,'accepted.json'))));
 }finally{db.close();}
}
const proxy=createServer(async(req,res)=>{
 try{
  if(resume)assert.notEqual(req.method,'POST','Read-only continuation cannot submit a task');
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const method=req.method,body=chunks.length?Buffer.concat(chunks):undefined;
  const upstream=await fetch(config.endpoint+req.url,{method,headers:{Authorization:req.headers.authorization,...(body?{'Content-Type':'application/json'}:{})},body,redirect:'error'});
  const bytes=Buffer.from(await upstream.arrayBuffer());
  if(method==='POST'){
   assert.equal(req.url,'/api/synplex/executions');posts++;
   assert.equal(upstream.status,202);acceptedTaskId=JSON.parse(bytes).execution_id;
   writeFileSync(join(directory,'accepted.json'),JSON.stringify({acceptedTaskId,posts}),{flag:'wx',mode:0o600});
   req.socket.destroy();return;
  }
  res.writeHead(upstream.status,{'Content-Type':upstream.headers.get('Content-Type')??'application/json'});res.end(bytes);
 }catch(error){res.destroy(error);}
});
await new Promise((resolve,reject)=>{proxy.once('error',reject);proxy.listen(proxyPort,'127.0.0.1',resolve);});
if(!resume)writeFileSync(join(directory,'proxy-settings.json'),JSON.stringify({port:proxy.address().port}),{flag:'wx',mode:0o600});
const options={endpoint:'http://127.0.0.1:'+proxy.address().port,tokenFile:config.tokenFile,workflowId:config.workflowId,
 dataDir:join(directory,'journal'),provider:'deepseek',model:'deepseek-flash',effort:'low',allowedModels:[{id:'deepseek-flash',efforts:['low']}]};
const coordinator=()=>new ExecutionCoordinator({repository,adapters:{synplex:createAgentHubExecutor(options)}});
try{
 repository=new WorkspaceRepository({dataDir:join(directory,'workspace')});
 const credential=repository.createCredential({ownerId:'private-test',actorId:'human',scope,kind:'ui',capabilities:['read_memory','prepare_task','execute','record_result']});
 let auth=repository.authenticate(credential.token);execution=coordinator();
 const service=new WorkspaceService({repository,modules:{context}}),meta={protocolVersion:'synplex.workspace/1.0.0',scope,expectedStateRevision:0};
 let admitted=original;
 if(!resume){
  const prepared=await service.call(auth,'prepare_task',{...meta,requestId:'prepare',goal:'只核对本次任务是否被收到',constraints:['此验收不启动工作进程或模型'],acceptanceCriteria:['同一任务编号'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:2000,executionOptions:{model:'deepseek-flash',effort:'low'}});
  const start={...meta,requestId:'start',runId:prepared.run.id},grant=repository.issueExecutionAuthorization(auth,start);
  admitted=await execution.start(auth,{...start,authorizationId:grant.authorizationId});await execution.idle();
 }
 assert.equal(posts,1);assert.ok(acceptedTaskId);
 assert.equal(repository.executionState(auth,scope,admitted.operation.id).operation.status,'unknown');
 assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,null);
 await execution.close();repository.close();repository=new WorkspaceRepository({dataDir:join(directory,'workspace')});
 auth=repository.authenticate(credential.token);execution=coordinator();app=createWorkspaceServer({repository,execution});const endpoint=await app.listen();
 const response=await fetch(endpoint+'/api/v1/reconcile_execution',{method:'POST',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:meta.protocolVersion,scope,operationId:admitted.operation.id})});
 assert.equal(response.status,200);const state=await response.json();
 assert.equal(state.attempt.id,admitted.attempt.id);
 assert.equal(repository.read(auth,scope,'remote_submission',admitted.operation.id).taskId,acceptedTaskId);
 // The task has not run. Finding its identity must not pretend it succeeded.
 assert.equal(state.operation.status,'unknown');assert.equal(state.results.length,0);
 assert.equal(repository.list(auth,scope,'attempt').length,1);assert.equal(repository.usageLedger(auth,scope).totals.paidUsd,null);
 assert.equal(repository.list(auth,scope,'result_review').length,0);assert.equal(posts,1);
 writeFileSync(join(directory,'node-result.json'),JSON.stringify({actualEngineHttp:true,firstAcknowledgementDropped:true,
  sqliteReopened:true,originalIdentityRecovered:true,operationId:admitted.operation.id,attemptId:admitted.attempt.id,
  executionId:acceptedTaskId,posts,newPostsThisContinuation:resume?0:1,attempts:1,results:0,modelCalls:0,paidCost:null,
  limitation:'Real intake/lookup only; task remains pending without a worker. No model or business completion validation.'},null,2),{flag:'wx',mode:0o600});
 console.log('真实API接收→丢回执→SQLite重开→原接口只读找回通过；一份原任务，无成功成果或模型调用。');
}finally{
 await app?.close();await execution?.close();repository?.close();await new Promise(resolve=>proxy.close(resolve));
}
