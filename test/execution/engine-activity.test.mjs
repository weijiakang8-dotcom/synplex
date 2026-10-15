import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
import {agentHubActivity} from '../../adapters/execution/agenthub-activity.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';

test('原任务步骤只读同步、回执丢失及重开不重复；错序/串任务/污染/未知工具不能伪造进度或执行',async t=>{
 const directory=mkdtempSync(join(tmpdir(),'synplex-progress-')),scope={projectId:'progress',versionId:null,branchId:null};
 let repository=new WorkspaceRepository({dataDir:directory});t.after(()=>{repository.close();rmSync(directory,{recursive:true,force:true});});
 const credential=repository.createCredential({ownerId:'fixture',actorId:'human',kind:'ui',scope,capabilities:['read_memory','prepare_task','execute']});
 let auth=repository.authenticate(credential.token);
 const service=new WorkspaceService({repository,modules:{context}}),protocolVersion='synplex.workspace/1.0.0';
 const prepared=await service.call(auth,'prepare_task',{protocolVersion,scope,requestId:'prepare',expectedStateRevision:0,goal:'整理项目报告',constraints:[],acceptanceCriteria:['文件可下载'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:4000});
 const input={protocolVersion,scope,requestId:'start',expectedStateRevision:0,runId:prepared.run.id},grant=repository.issueExecutionAuthorization(auth,input);
 const admitted=repository.admitExecution(auth,{...input,authorizationId:grant.authorizationId}),operationId=admitted.operationId,claimed=repository.claimExecution(auth,scope,operationId);
 const taskId=randomUUID(),workflowId=randomUUID();
 repository.reserveRemoteSubmission(auth,scope,operationId,claimed.attemptId,{packetHash:prepared.packet.contentHash,payloadHash:payloadHash({fixture:true}),targetKey:'a'.repeat(64)});
 repository.bindRemoteTask(auth,scope,operationId,claimed.attemptId,taskId);
 const source=sequence=>({execution_id:taskId,event_id:randomUUID(),sequence});
 const events=[{...source(1),event:'activity',phase:'plan',status:'started',description:'PRIVATE_PROMPT'},
  {...source(2),event:'token',token:'PRIVATE_THOUGHT'},
  {...source(3),event:'tool_call',tool_name:'export_document',params:{key:'PRIVATE_SECRET'}},
  {...source(4),event:'tool_result',tool_name:'export_document',status:'success',result:'PRIVATE_RESULT'},
  {...source(5),event:'tool_call',tool_name:'__proto__',description:'PRIVATE_PATH'}];
 let page={execution:{id:taskId,workflow_id:workflowId},events,cursor:5,has_more:false},reads=0,saves=0,at=10000,failAck=true;
 const record={taskId},reported=[];
 const report=event=>{
  const result=repository.appendExecutionActivity(auth,scope,operationId,claimed.claimId,event);reported.push(event);
  if(failAck&&event.source){failAck=false;throw Error('fixture lost acknowledgement after commit');}
  return result;
 };
 const observe=agentHubActivity({now:()=>at,save:()=>saves++,request:async(path,options)=>{
  reads++;assert.equal(path,'/api/executions/'+taskId+'/activity?after='+(record.activityCursor??0));assert.equal(options.timeoutMs,2000);return page;
 }}),watch={operationId,signal:new AbortController().signal,report};
 await observe(watch,record,workflowId);assert.equal(record.activityCursor,undefined);assert.equal(saves,0);
 at+=5000;await observe(watch,record,workflowId);assert.equal(record.activityCursor,5);assert.equal(saves,1);
 let activity=repository.executionState(auth,scope,operationId).activity;assert.deepEqual(activity.filter(x=>x.source).map(x=>x.stage),['planning','exporting','tool_done','tool']);
 assert.doesNotMatch(JSON.stringify(activity),/PRIVATE_|export_document|__proto__|token/);
 const first=activity[0];assert.throws(()=>report({stage:'working',source:first.source}),{code:'conflict'});
 assert.throws(()=>report({stage:'working',source:{...first.source,eventId:randomUUID()}}),{code:'conflict'});
 assert.throws(()=>report({stage:'working',source:{...first.source,taskId:randomUUID()}}),{code:'scope_denied'});
 assert.throws(()=>report({stage:'PRIVATE_LABEL'}),{code:'validation_failed'});
 assert.throws(()=>repository.appendExecutionActivity(auth,{...scope,projectId:'foreign'},operationId,claimed.claimId,{stage:'working'}),{code:'scope_denied'});
 repository.close();repository=new WorkspaceRepository({dataDir:directory});auth=repository.authenticate(credential.token);
 const replay=agentHubActivity({request:async()=>page,save:()=>{}});await replay(watch,{taskId},workflowId);
 assert.equal(repository.executionState(auth,scope,operationId).activity.length,5,'reopening and losing the side cursor does not duplicate durable steps');
 for(const bad of [{...page,execution:{id:randomUUID(),workflow_id:workflowId}},{...page,execution:{id:taskId,workflow_id:randomUUID()}},{...page,cursor:6},{...page,events:[events[1],events[0]]},{...page,has_more:true},{...page,events:Array(201).fill(events[0])}]){
  const invalid=agentHubActivity({request:async()=>bad,save:()=>assert.fail('invalid cursor must not be saved')});
  const out=[];await invalid({...watch,report:event=>out.push(event)},{taskId},workflowId);assert.deepEqual(out,[{stage:'progress_unavailable'}]);
 }
 page=null;const before=reads;await observe(watch,record,workflowId);await observe(watch,record,workflowId);assert.equal(reads,before+1,'optional failures back off instead of blocking or retrying continuously');
 at+=5000;page={execution:{id:taskId,workflow_id:workflowId},events:[{...source(6),event:'execution_completed',description:'PRIVATE_RESULT'}],cursor:6,has_more:false};
 await observe(watch,record,workflowId);assert.equal(record.activityCursor,6);assert.equal(repository.executionState(auth,scope,operationId).activity.at(-1).stage,'execution_done');
 assert.equal(repository.list(auth,scope,'attempt').length,1);assert.equal(repository.list(auth,scope,'result').length,0);assert.equal(repository.operation(auth,scope,operationId).status,'running','step records never change execution or acceptance state');
});
