import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,writeFileSync,unlinkSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {WorkspaceService} from '../../services/workspace/service.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createAgentHubExecutor} from '../../adapters/execution/agenthub.mjs';
import {engineUsage} from '../../adapters/execution/agenthub-usage.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';
import {validatePrice,priceUsage} from '../../packages/execution/accounting.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {operationApproval} from '../../adapters/execution/agenthub-approval.mjs';
import {validateAnswers,validateQuestion} from '../../services/workspace/execution-question.mjs';
import {approvalDetails,questionAction,questionHelp} from '../../public/operation-approval.js';
test('操作确认绑定具体参数，默认无同意；回执丢失后只读核对，不重复发送或改变原选择',async()=>{
 const operationId=randomUUID(),attemptId=randomUUID(),taskId=randomUUID(),requestId=randomUUID(),hash='a'.repeat(64),targetKey='fixture';
 const record={operationId,attemptId,taskId,targetKey};let posts=0,reads=0,saved=0,delivered=0,wrong=false;
 const api=operationApproval({targetKey,save:(id,value)=>{assert.equal(id,operationId);assert.equal(value,record);saved++;},request:async(route,options={})=>{
  if(options.body){posts++;assert.deepEqual(options.body,{requestId,snapshotHash:hash,approved:true});throw Error('fixture lost acknowledgement');}
  if(route.endsWith('/approval'))return {protocol:'synplex.operation-approval/1',executionId:taskId,requestId,snapshotHash:hash,operations:[{tool:'send_email',params:{to:'test@synplex.invalid',subject:'<script>bad()</script>',body:'已冻结的正文'}}]};
  reads++;return {protocol:'synplex.operation-decision/1',executionId:taskId,requestId,decisionSha256:wrong?'0'.repeat(64):record.approvalIntents[requestId].decisionHash,deliveryState:'unknown'};
 }});
 const prompt=await api.pending({},record);assert.equal(prompt.questions[0].isOther,false);
 assert.throws(()=>validateAnswers(prompt,{approval:{answers:['随便执行']}}));
 const broken=structuredClone(prompt);broken.questions[0].isOther=true;assert.throws(()=>validateQuestion(broken));
 const esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
 const html=approvalDetails(prompt,esc);assert.match(html,/发送邮件/);assert.match(html,/收件人/);assert.match(html,/已冻结的正文/);assert.doesNotMatch(html,/<script>/);assert.equal(questionAction(prompt),'提交选择');assert.match(questionHelp(prompt),/不会默认同意/);
 const question={id:randomUUID(),operationId,status:'answered',prompt,answers:{approval:{answers:['允许这次操作']}}};
 await assert.rejects(api.answer({operationId,requestInput:async()=>({questionId:question.id,answers:question.answers}),inputDelivered:()=>delivered++},record,prompt),/lost acknowledgement/);
 assert.equal(posts,1);assert.equal(saved,1);assert.equal(delivered,0);
 assert.equal(await api.inspect({record,operationId,attemptId,question}),true);assert.equal(posts,1);assert.equal(reads,1);
 wrong=true;await assert.rejects(api.inspect({record,operationId,attemptId,question}),{code:'conflict'});wrong=false;
 await assert.rejects(api.pending({},record),{code:'conflict'});assert.equal(posts,1);
 await assert.rejects(api.inspect({record,operationId,attemptId:randomUUID(),question}),{code:'conflict'});
});
test('AgentHub bridge reuses the authenticated workflow, submits once, verifies actual files and recovers only by reading the bound task',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-agenthub-http-'));let repository=new WorkspaceRepository({dataDir:join(dir,'db')});
 const scope={projectId:'bridge-fixture',versionId:null,branchId:null},workflowId=randomUUID(),taskId=randomUUID(),artifactId=randomUUID(),bytes=Buffer.from('# 已生成的文件\n合成验收，不是客户成绩。');
 const credential=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']});let auth=repository.authenticate(credential.token);
 const tokenFile=join(dir,'token');writeFileSync(tokenFile,'fixture-private-bearer',{mode:0o600});let submissions=0,forwarded,lookups=0,badHash=false,blocked=false,asking=false,answers=0;
 const questionId=randomUUID();let fileProtocol=true,documentText=false,deliveryProof='unavailable',deliveryReads=0;
 const backend=http.createServer(async(req,res)=>{
  assert.equal(req.headers.authorization,'Bearer fixture-private-bearer');
  if(req.url==='/api/workflows/'+workflowId){res.end(JSON.stringify({id:workflowId}));return;}
  if(req.url==='/api/synplex/model-options'){res.end(JSON.stringify({protocol:'synplex.engine-selection/1',choices:[{id:'fixture-model',provider:'fixture',efforts:['low','high']}]}));return;}
  if(req.url==='/api/synplex/input-capabilities'){res.end(JSON.stringify({protocol:fileProtocol?'synplex.engine-input-files/1':'old-engine',sourceFiles:true,documentText,maxBytes:8*1024*1024,maxFiles:30}));return;}
  if(req.method==='POST'&&req.url==='/api/synplex/executions'){submissions++;let text='';for await(const b of req)text+=b;forwarded=JSON.parse(text);res.writeHead(202);res.end(JSON.stringify({execution_id:taskId,status:'pending',model_selection:forwarded.model_selection}));return;}
  if(req.url==='/api/executions/'+taskId+'/activity?after=0'){res.end(JSON.stringify({execution:{id:taskId,workflow_id:workflowId},events:[{execution_id:taskId,event_id:'11111111-1111-4111-8111-111111111111',sequence:1,event:'activity',phase:'plan',status:'started',description:'PRIVATE_EXECUTION_PROMPT'},{execution_id:taskId,event_id:'22222222-2222-4222-8222-222222222222',sequence:2,event:'tool_call',tool_name:'export_document',params:{credential:'PRIVATE_TOOL_SECRET'}}],cursor:2,has_more:false}));return;}
  if(req.url==='/api/executions/'+taskId){lookups++;res.end(JSON.stringify({id:taskId,workflow_id:workflowId,status:asking?'waiting_for_approval':'completed',final_output:'合成任务已完成。',completed_at:null,token_usage:{'fixture-model':{input_tokens:1500,output_tokens:100}},checkpoint_data:{...(asking?{interrupt:{type:'clarification',clarification:{clarification_id:questionId}}}:{}),delivery:{blockers:blocked?[{code:'missing_artifact',reason:'missing document'}]:[]}}}));return;}
  if(req.url==='/api/synplex/executions/'+taskId+'/usage'){res.end(JSON.stringify({protocol:'synplex.engine-usage/1',executionId:taskId,workflowId,recordedCalls:1,model:'fixture-model',inputTokens:1500,outputTokens:100,provenance:'provider_receipt',coverage:'completed_recorded_calls',paidUsd:null}));return;}
  if(req.url==='/api/dispatch/clarifications?execution_id='+taskId){res.end(JSON.stringify([{id:questionId,execution_id:taskId,status:'pending',step_id:'format',question:'需要哪种文件？',options:['文字','表格']} ]));return;}
  if(req.url==='/api/dispatch/clarifications/'+questionId+'/answer'){answers++;let text='';for await(const b of req)text+=b;assert.deepEqual(JSON.parse(text),{answer:'文字'});asking=false;req.socket.destroy();return;}
  if(req.url==='/api/synplex/executions/'+taskId+'/input-deliveries/'+questionId){deliveryReads++;assert.equal(req.method,'GET');if(deliveryProof==='unavailable'){res.writeHead(404);res.end();return;}res.end(JSON.stringify({protocol:'synplex.input-delivery/1',executionId:taskId,questionId,answerSha256:deliveryProof==='wrong'?'0'.repeat(64):sha256(Buffer.from('文字')),deliveryState:'unknown'}));return;}
  if(req.url==='/api/artifacts?execution_id='+taskId){res.end(JSON.stringify([{id:artifactId,filename:'文件.md',size:bytes.length,sha256:badHash?'0'.repeat(64):sha256(bytes),format:'md',download_url:'http://evil.invalid/read-secrets'}]));return;}
  if(req.url==='/api/artifacts/'+artifactId+'/download'){res.end(bytes);return;}
  res.writeHead(404);res.end();
 });await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 const adapterOptions={endpoint:'http://127.0.0.1:'+backend.address().port,workflowId,tokenFile,dataDir:join(dir,'bridge'),pollMs:5,model:'fixture-model',provider:'fixture',effort:'low',allowedModels:[{id:'fixture-model',efforts:['low','high']}]},adapter=createAgentHubExecutor(adapterOptions);let execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter}});const service=new WorkspaceService({repository,modules:{context}});let reconciliationApp;
 t.after(async()=>{await execution.close();if(reconciliationApp)await reconciliationApp.close();await new Promise(r=>backend.close(r));repository.close();rmSync(dir,{recursive:true,force:true});});
 const imported=await importSource(await repository.forScope(auth,scope),{bytes:Buffer.from('分类,收入\n房费,0.1\n房费,0.2\n'),format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:'source-table',occurredAt:null,importOrigin:'isolated_test'},{requestId:'source-table',expectedStateRevision:0});
 repository.updateSourceMetadata(auth,{protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'table-name',expectedStateRevision:repository.state(auth,scope).stateRevision,sourceId:imported.source.id,expectedMetadataRevision:0,metadata:{title:'收入.csv',category:'',tags:[],locked:false}});
 const prep=await service.call(auth,'prepare_task',{protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'bridge-prep',expectedStateRevision:repository.state(auth,scope).stateRevision,goal:'交付一个说明文档',constraints:['保留原资料'],acceptanceCriteria:['文件可下载'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[imported.occurrences[0].id],maxInputTokens:4000,executionOptions:{model:'fixture-model',effort:'high'}});
 const originalFiles=repository.selectedSourceFiles(auth,scope,{selectedOccurrenceIds:[imported.occurrences[0].id,imported.occurrences[0].id]});assert.equal(originalFiles.length,1);assert.equal(originalFiles[0].sourceId,imported.source.id);assert.equal(originalFiles[0].name,'收入.csv');
 assert.throws(()=>repository.selectedSourceFiles(auth,{...scope,projectId:'foreign'},prep.packet),{code:'scope_denied'});
 const input={protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'bridge-start',expectedStateRevision:repository.state(auth,scope).stateRevision,runId:prep.run.id},grant=repository.issueExecutionAuthorization(auth,input),start={...input,authorizationId:grant.authorizationId};
 const a=await execution.start(auth,start);await execution.idle();const done=repository.executionState(auth,scope,a.operation.id);
 assert.deepEqual(done.activity.filter(a=>a.source).map(a=>a.stage),['planning','exporting']);assert.doesNotMatch(JSON.stringify(done.activity),/PRIVATE_|export_document/);
 assert.equal(submissions,1);assert.equal(done.operation.status,'succeeded');assert.equal(done.results[0].usage.costUsd,null);assert.equal(forwarded.workflow_id,workflowId);assert.match(forwarded.user_input,/保留原资料/);
 assert.deepEqual(forwarded.model_selection,{provider:'fixture',model:'fixture-model',reasoning_effort:'high'});
 assert.equal(forwarded.input_files.length,1);assert.equal(forwarded.input_files[0].sourceId,imported.source.id);assert.equal(Object.hasOwn(forwarded.input_files[0],'resultId'),false);assert.deepEqual(Buffer.from(forwarded.input_files[0].contentBase64,'base64'),Buffer.from(repository.getBlob(auth,scope,imported.source.id).bytes));
 assert.equal(done.results[0].usage.inputTokens,1500);assert.equal(done.results[0].usage.outputTokens,100);assert.equal(done.results[0].usage.cachedInputTokens,null);
 assert.equal(done.results[0].usage.provenance,'provider_receipt');
 const legacy={id:taskId,workflow_id:workflowId,token_usage:{'fixture-model':{input_tokens:1500,output_tokens:100}}};
 assert.equal(engineUsage(legacy).provenance,'estimate');assert.equal(engineUsage(legacy).observationScope,'host_unavailable');
 const proof={protocol:'synplex.engine-usage/1',executionId:taskId,workflowId,recordedCalls:2,model:'fixture-model',inputTokens:1600,outputTokens:120,provenance:'estimate',coverage:'partial_or_unknown',paidUsd:999};
 assert.deepEqual([engineUsage(legacy,proof).inputTokens,engineUsage(legacy,proof).provenance,engineUsage(legacy,proof).costUsd],[1600,'estimate',null]);
 for(const bad of [{...proof,executionId:randomUUID()},{...proof,model:{}},{...proof,inputTokens:-1},{...proof,recordedCalls:0}])assert.equal(engineUsage(legacy,bad).inputTokens,1500);
 assert.deepEqual(repository.artifactFile(auth,scope,done.results[0].id,artifactId).bytes,bytes);
 await execution.start(auth,start);assert.equal(submissions,1);
 // Simulate the private side journal being lost after SQLite bound the remote ID.
 unlinkSync(join(dir,'bridge',a.operation.id+'.json'));await execution.reconcile(auth,scope,a.operation.id);assert.equal(submissions,1);assert.ok(lookups>=2);
 badHash=true;await assert.rejects(execution.reconcile(auth,scope,a.operation.id));assert.deepEqual(repository.artifactFile(auth,scope,done.results[0].id,artifactId).bytes,bytes,'Failed recheck preserves the original verified bytes');
 badHash=false;blocked=true;asking=true;
 const meta=()=>({protocolVersion:'synplex.workspace/1.0.0',scope,requestId:randomUUID(),expectedStateRevision:repository.state(auth,scope).stateRevision});
 const plan=repository.createTaskPlan(auth,{...meta(),baseRunId:prep.run.id,baseResultId:done.results[0].id,plan:{title:'修改说明',nodes:[{id:'revise',title:'修改说明',instruction:'保留原文补充说明',acceptanceCriteria:['文件可下载'],dependsOn:[],sideEffect:'isolated_files'}]}}).value;
 const nextPrep=await service.prepareStep(auth,{...meta(),planId:plan.id,nodeId:'revise',instruction:'补充说明',baseResultId:done.results[0].id});
 fileProtocol=false;await assert.rejects(adapter.preflight({packet:nextPrep.packet}),{code:'capability_unavailable'});assert.equal(submissions,1);fileProtocol=true;
 await assert.rejects(adapter.preflight({packet:nextPrep.packet,sourceFiles:[{...originalFiles[0],mediaType:'application/pdf',name:'原资料.pdf'}]}),{code:'capability_unavailable'});assert.equal(submissions,1);documentText=true;
 await adapter.preflight({packet:nextPrep.packet,sourceFiles:[{...originalFiles[0],mediaType:'application/pdf',name:'原资料.pdf'}]});assert.equal(submissions,1);
 await assert.rejects(adapter.preflight({packet:{...nextPrep.packet,taskInputs:[{artifacts:[{byteLength:9*1024*1024}]}]}}),{code:'budget_exceeded'});assert.equal(submissions,1);
 const next={...input,requestId:'bridge-blocked-start',expectedStateRevision:repository.state(auth,scope).stateRevision,runId:nextPrep.run.id};
 const nextGrant=repository.issueExecutionAuthorization(auth,next),partial=await execution.start(auth,{...next,authorizationId:nextGrant.authorizationId});
 let question;
 for(let i=0;i<100;i++){question=repository.executionState(auth,scope,partial.operation.id).questions[0];if(question)break;await new Promise(r=>setTimeout(r,5));}
 assert.ok(question);assert.equal(question.prompt.threadId,taskId);
 await execution.answer(auth,{protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'answer-original',expectedStateRevision:repository.state(auth,scope).stateRevision,questionId:question.id,answers:{answer:{answers:['文字']}}});
 await execution.idle();assert.equal(answers,1);
 assert.equal(repository.executionState(auth,scope,partial.operation.id).operation.status,'unknown');
 assert.equal(repository.executionState(auth,scope,partial.operation.id).questions[0].delivery,'pending');
 // Reopen real SQLite and the adapter journal. Reconciliation must only GET.
 await execution.close();repository.close();repository=new WorkspaceRepository({dataDir:join(dir,'db')});auth=repository.authenticate(credential.token);
 execution=new ExecutionCoordinator({repository,adapters:{synplex:createAgentHubExecutor(adapterOptions)}});
 reconciliationApp=createWorkspaceServer({repository,execution});const reconciliationEndpoint=await reconciliationApp.listen();
 const checkDelivery=()=>fetch(reconciliationEndpoint+'/api/v1/reconcile_execution',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential.token},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,operationId:partial.operation.id})});
 deliveryProof='wrong';assert.equal((await checkDelivery()).status,409);
 assert.equal(repository.executionState(auth,scope,partial.operation.id).questions[0].delivery,'pending');
 deliveryProof='correct';const checked=await checkDelivery();assert.equal(checked.status,200);assert.equal((await checked.json()).questions[0].delivery,'sent');
 assert.equal(repository.executionState(auth,scope,partial.operation.id).questions[0].delivery,'sent');
 assert.equal(answers,1);assert.equal(submissions,2);assert.equal(deliveryReads,2);

 assert.equal(repository.executionState(auth,scope,partial.operation.id).operation.status,'failed','Lifecycle completed does not hide unmet delivery requirements');assert.equal(submissions,2);
 assert.equal(forwarded.input_files.length,2);assert.equal(forwarded.input_files[0].resultId,done.results[0].id);assert.equal(forwarded.input_files[0].artifactId,artifactId);assert.equal(forwarded.input_files[0].sha256,sha256(bytes));assert.deepEqual(Buffer.from(forwarded.input_files[0].contentBase64,'base64'),bytes);assert.equal(forwarded.input_files[1].sourceId,imported.source.id);
 const ledger=repository.usageLedger(auth,scope);assert.equal(ledger.rows.length,2);assert.equal(ledger.rows.filter(r=>r.status==='failed').length,1);assert.equal(ledger.totals.paidUsd,null);assert.equal(ledger.totals.unknownPaidCount,2);
 const reconcile={protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'invoice',expectedStateRevision:repository.state(auth,scope).stateRevision,attemptId:ledger.rows[0].attemptId,costUsd:0.03,receiptReference:'synthetic-invoice:line-1',supersedesId:null};
 const invoice=repository.reconcileUsage(auth,reconcile);assert.equal(repository.reconcileUsage(auth,reconcile).duplicate,true);
 assert.throws(()=>repository.reconcileUsage(auth,{...reconcile,requestId:'foreign',attemptId:'foreign'}),{code:'scope_denied'});
 assert.throws(()=>repository.reconcileUsage(auth,{...reconcile,requestId:'double',attemptId:ledger.rows[1].attemptId}),{code:'conflict'});
 repository.reconcileUsage(auth,{...reconcile,requestId:'correction',costUsd:0.04,supersedesId:invoice.value.id});
 assert.equal(repository.list(auth,scope,'usage_reconciliation').length,2);assert.equal(repository.usageLedger(auth,scope).rows[0].paidUsd,0.04);assert.equal(repository.usageLedger(auth,scope).totals.paidUsd,null);
 const p=validatePrice({provider:'fixture',model:'fixture-model',validFrom:'2026-01-01T00:00:00Z',validUntil:null,inputUsdPerMillion:2,cachedInputUsdPerMillion:1,outputUsdPerMillion:4,source:'synthetic-test'});
 const u={...done.results[0].usage,provider:'fixture',cachedInputTokens:1000};
 assert.equal(priceUsage(u,[p],ledger.rows[0].createdAt).usd,0.0024);
 assert.equal(priceUsage(u,[p,p],ledger.rows[0].createdAt).reason,'price_conflict');
 assert.equal(priceUsage({...u,observationScope:'run'},[p],ledger.rows[0].createdAt).usd,null);
 assert.throws(()=>createAgentHubExecutor({endpoint:'https://evil.invalid',workflowId,tokenFile,dataDir:dir}));
});
test('cancellation waits for the independently bound worker-return receipt; a stop request cannot unblock another execution',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-agenthub-stop-')),workflowId=randomUUID(),taskId=randomUUID(),operationId=randomUUID(),attemptId=randomUUID();
 const tokenFile=join(dir,'token');writeFileSync(tokenFile,'fixture-token',{mode:0o600});let marker=null,requests=0,error='Cancelled by user';
 const backend=http.createServer((req,res)=>{
  requests++;assert.equal(req.method,'GET');
  if(req.url==='/api/executions/'+taskId)res.end(JSON.stringify({id:taskId,workflow_id:workflowId,status:'failed',error_message:error,checkpoint_data:{synplexWorkerReceipt:marker}}));
  else if(req.url==='/api/artifacts?execution_id='+taskId)res.end('[]');else{res.writeHead(404);res.end();}
 });await new Promise(r=>backend.listen(0,'127.0.0.1',r));t.after(async()=>{await new Promise(r=>backend.close(r));rmSync(dir,{recursive:true,force:true});});
 const endpoint='http://127.0.0.1:'+backend.address().port;
 const {payloadHash}=await import('../../packages/contracts/validate.mjs');
 const targetKey=payloadHash({endpoint,workflowId,tokenFile});
 writeFileSync(join(dir,operationId+'.json'),JSON.stringify({operationId,attemptId,targetKey,taskId}),{mode:0o600});
 const adapter=createAgentHubExecutor({endpoint,tokenFile,workflowId,dataDir:dir,requireWorkerReceipt:true});
 assert.equal(await adapter.lookup({operationId,attemptId}),null);
 marker={version:'synplex.worker-return/1',executionId:randomUUID(),workflowId,workerReturned:true,statusAtReturn:'failed',taskId:'fixture-celery-task',recordedAt:new Date().toISOString()};
 assert.equal(await adapter.lookup({operationId,attemptId}),null,'Foreign task acknowledgement cannot clear uncertainty');
 marker.executionId=taskId;marker.workerReturned=false;assert.equal(await adapter.lookup({operationId,attemptId}),null);
 marker.workerReturned=true;const settled=await adapter.lookup({operationId,attemptId});assert.equal(settled.status,'cancelled');assert.match(settled.result.summary,/确认停止/);assert.equal(settled.result.usage.costUsd,null);assert.equal(requests,6);
 error='approval_rejected';const rejected=await adapter.lookup({operationId,attemptId});assert.equal(rejected.status,'failed');assert.match(rejected.result.summary,/拒绝.*任务已停止/);assert.match(rejected.result.summary,/修改要求/);assert.equal(rejected.result.usage.costUsd,null);
});
test('engine reconnect restores the original durable question after reopening the workspace, without another submission or attempt',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-engine-input-reopen-')),scope={projectId:'input-reopen',versionId:null,branchId:null};
 const workflowId=randomUUID(),taskId=randomUUID(),questionId=randomUUID(),tokenFile=join(dir,'token');writeFileSync(tokenFile,'fixture-token',{mode:0o600});
 let submissions=0,answers=0,waiting=true;
 const backend=http.createServer(async(req,res)=>{
  if(req.url==='/api/workflows/'+workflowId){res.end(JSON.stringify({id:workflowId}));return;}
  if(req.method==='POST'&&req.url==='/api/executions'){submissions++;res.end(JSON.stringify({execution_id:taskId}));return;}
  if(req.url==='/api/executions/'+taskId){res.end(JSON.stringify({id:taskId,workflow_id:workflowId,status:waiting?'waiting_for_approval':'completed',final_output:'原任务已继续。',checkpoint_data:waiting?{interrupt:{type:'clarification',clarification:{clarification_id:questionId}}}:{}}));return;}
  if(req.url==='/api/dispatch/clarifications?execution_id='+taskId){res.end(JSON.stringify([{id:questionId,execution_id:taskId,status:'pending',step_id:'format',question:'需要哪种文件？',options:['文字','表格']} ]));return;}
  if(req.url==='/api/dispatch/clarifications/'+questionId+'/answer'){answers++;let text='';for await(const b of req)text+=b;assert.deepEqual(JSON.parse(text),{answer:'文字'});waiting=false;res.end(JSON.stringify({clarification_id:questionId,execution_id:taskId,status:'resuming'}));return;}
  if(req.url==='/api/artifacts?execution_id='+taskId){res.end('[]');return;}
  res.writeHead(404);res.end();
 });await new Promise(r=>backend.listen(0,'127.0.0.1',r));
 let repository=new WorkspaceRepository({dataDir:join(dir,'db')});
 const credential=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']});
 let auth=repository.authenticate(credential.token);
 const makeAdapter=()=>createAgentHubExecutor({endpoint:'http://127.0.0.1:'+backend.address().port,workflowId,tokenFile,dataDir:join(dir,'bridge'),pollMs:5});
 let execution=new ExecutionCoordinator({repository,adapters:{synplex:makeAdapter()},timeoutMs:200,inputTimeoutMs:40,leaseMs:1000}),app;
 t.after(async()=>{await execution.close();if(app)await app.close();repository.close();await new Promise(r=>backend.close(r));rmSync(dir,{recursive:true,force:true});});
 const service=new WorkspaceService({repository,modules:{context}});
 const prep=await service.call(auth,'prepare_task',{protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'prepare',expectedStateRevision:0,goal:'继续完成说明',constraints:[],acceptanceCriteria:['保留原任务'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:4000});
 const request={protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'start',expectedStateRevision:0,runId:prep.run.id},grant=repository.issueExecutionAuthorization(auth,request);
 const started=await execution.start(auth,{...request,authorizationId:grant.authorizationId});await execution.idle();
 const old=repository.executionState(auth,scope,started.operation.id);assert.equal(old.operation.status,'unknown');assert.equal(old.questions.length,1);
 await execution.close();repository.close();repository=new WorkspaceRepository({dataDir:join(dir,'db')});auth=repository.authenticate(credential.token);
 execution=new ExecutionCoordinator({repository,adapters:{synplex:makeAdapter()},timeoutMs:200,inputTimeoutMs:2000,leaseMs:1000});
 await execution.recover(auth,scope);
 app=createWorkspaceServer({repository,execution});const url=await app.listen();
 const post=(path,input)=>fetch(url+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+credential.token},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,...input})});
 assert.equal((await post('ui_reconnect_input',{operationId:started.operation.id})).status,200);
 let live;
 for(let i=0;i<100;i++){live=repository.executionState(auth,scope,started.operation.id);if(live.questions.some(q=>q.status==='pending'))break;await new Promise(r=>setTimeout(r,5));}
 const q=live.questions.find(q=>q.status==='pending');assert.ok(q);assert.equal(q.prompt.remoteRequestId,questionId);assert.equal(live.attempt.id,old.attempt.id);
 assert.equal((await post('ui_answer_question',{requestId:'answer',expectedStateRevision:0,questionId:q.id,answers:{answer:{answers:['文字']}}})).status,200);await execution.idle();
 const done=repository.executionState(auth,scope,started.operation.id);assert.equal(done.operation.status,'succeeded');assert.equal(answers,1);assert.equal(submissions,1);
 assert.equal(repository.list(auth,scope,'attempt').length,1);assert.equal(done.questions.length,2);assert.equal(done.questions[0].status,'unavailable');assert.equal(done.questions[1].delivery,'sent');assert.equal(repository.list(auth,scope,'execution_recovery').length,1);
});
