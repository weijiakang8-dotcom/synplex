import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {EventEmitter} from 'node:events';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createCodexExecutor} from '../../adapters/execution/codex.mjs';
import * as context from '../../packages/context/index.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {snapshotWorkspace,restoreWorkspace} from '../../scripts/runtime/recovery.mjs';
const protocolVersion='synplex.workspace/1.0.0',scope={projectId:'execution-http-fixture',versionId:null,branchId:null};

test('explicit HTTP execution carries the complete packet, records progress, returns actual bytes and replays only its original operation',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-execution-http-')),repository=new WorkspaceRepository({dataDir});
 const caps=['read_memory','write_memory','prepare_task','record_result','execute'];
 const human=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:[...caps,'review_memory']}),agent=repository.createCredential({ownerId:'owner',actorId:'agent',scope,capabilities:caps});
 let turns=0,seen;
 class RpcFixture extends EventEmitter{
  async connect(){}close(){}respond(){}
  async call(method,p){
   if(method==='thread/start'){this.cwd=p.cwd;assert.equal(p.approvalPolicy,'never');assert.equal(p.config['features.multi_agent'],false);return {thread:{id:'isolated-thread'}};}
   if(method==='turn/start'){
    turns++;seen=JSON.parse(p.input[0].text.split('\n').slice(1).join('\n'));assert.equal(p.sandboxPolicy.networkAccess,false);
    const sources=seen.inputFilePaths.filter(f=>f.sourceId),previous=seen.inputFilePaths.filter(f=>f.resultId);
    assert.equal(sources.length,1);assert.equal(Object.hasOwn(sources[0],'resultId'),false);assert.equal(readFileSync(join(this.cwd,sources[0].path),'utf8'),'这是本次选中的原资料。');
    if(previous.length){assert.equal(previous.length,1);assert.match(readFileSync(join(this.cwd,previous[0].path),'utf8'),/真正的合成文件/);assert.equal(seen.taskInputs[0].role,'previous_version');}
    writeFileSync(join(this.cwd,'交付.md'),'# 真正的合成文件\n\n'+seen.goal);
    setTimeout(()=>{this.emit('notification',{method:'item/started',params:{threadId:'isolated-thread',item:{type:'commandExecution'}}});this.emit('notification',{method:'item/completed',params:{threadId:'isolated-thread',item:{type:'agentMessage',text:'合成文件已保存。'}}});this.emit('notification',{method:'turn/completed',params:{threadId:'isolated-thread',turn:{status:'completed'}}});},0);
    return {turn:{id:'isolated-turn'}};
   }
   throw new Error('Unexpected fixture call');
  }
 }
 const adapter=createCodexExecutor({binary:'/fixture/codex',home:dataDir,dataDir:join(dataDir,'codex'),model:'fixture-model',provider:'fixture-provider',rpcFactory:()=>new RpcFixture()});
 const execution=new ExecutionCoordinator({repository,adapters:{codex:adapter}}),app=createWorkspaceServer({repository,modules:{context},execution});
 let closed=false;const backupDir=dataDir+'-backup',restoredDir=dataDir+'-restored';
 const endpoint=await app.listen();t.after(async()=>{if(!closed){await app.close();repository.close();}for(const p of [dataDir,backupDir,restoredDir])rmSync(p,{recursive:true,force:true});});
 const headers={'Content-Type':'application/json',Authorization:'Bearer '+human.token},post=(action,input,extra={})=>fetch(endpoint+'/api/v1/'+action,{method:'POST',headers:{...headers,...extra},body:JSON.stringify({protocolVersion,scope,...input})});
 const auth=repository.authenticate(human.token),revisionNow=()=>repository.state(auth,scope).stateRevision;
 const source=await importSource(await repository.forScope(auth,scope),{bytes:Buffer.from('这是本次选中的原资料。'),format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:'original-source',occurredAt:null,importOrigin:'isolated_test'},{requestId:'source-original',expectedStateRevision:0});
 const prep=await (await post('prepare_task',{requestId:'prepare-complete',expectedStateRevision:revisionNow(),goal:'全文保留目标：整理项目，不假称业务成功。',constraints:['不能删旧源码','不能外发'],acceptanceCriteria:['可下载真实Markdown'],mode:'delegated',executor:'codex',selectedOccurrenceIds:[source.occurrences[0].id],maxInputTokens:4000})).json();
 assert.equal(turns,0,'Preparing cannot launch a turn');
 const input={requestId:'execute-once',expectedStateRevision:revisionNow(),runId:prep.run.id};
 assert.equal((await post('authorize_execution',input,{Authorization:'Bearer '+agent.token})).status,403);
 const grant=await (await post('authorize_execution',input)).json(),request={...input,authorizationId:grant.authorizationId};
 assert.equal((await post('execute_task',{...request,endpoint:'http://evil.invalid'})).status,400);
 const initial=await (await post('execute_task',request)).json();await execution.idle();
 const final=await (await post('execution_state',{operationId:initial.operation.id})).json();
 assert.equal(final.operation.status,'succeeded');assert.equal(final.results[0].trust,'platform_receipt');assert.ok(final.activity.length>=3);assert.deepEqual(seen.constraints,['不能删旧源码','不能外发']);
 assert.equal((await (await post('execute_task',request)).json()).operation.id,initial.operation.id);assert.equal(turns,1);
 const artifact=final.results[0].artifacts[0],response=await post('artifact_file',{resultId:final.results[0].id,artifactId:artifact.id});assert.equal(response.status,200);assert.match(await response.text(),/真正的合成文件/);
 const lessonInput={requestId:'lesson-once',expectedStateRevision:repository.state(repository.authenticate(human.token),scope).stateRevision,resultId:final.results[0].id,body:'先核对原文件，再判断任务是否交付。',condition:'有实际文件回执时，不能只看工具自述。'};
 const lesson=await (await post('ui_result_lesson',lessonInput)).json();assert.equal(lesson.reviewStatus,'pending');assert.equal(lesson.condition,lessonInput.condition);
 assert.equal((await (await post('ui_result_lesson',lessonInput)).json()).id,lesson.id);assert.equal((await post('ui_result_lesson',{...lessonInput,condition:'换一个条件'})).status,409);
 assert.equal((await post('ui_result_lesson',lessonInput,{Authorization:'Bearer '+agent.token})).status,403);
 assert.equal(lesson.evidence[0].quote,final.results[0].summary);assert.equal(repository.state(repository.authenticate(human.token),scope).lessons.length,0,'A proposed lesson is not a confirmed reusable conclusion');
 const lookup=await adapter.lookup({operationId:initial.operation.id,attemptId:final.attempt.id});assert.equal(lookup.status,'succeeded');assert.equal(turns,1,'Read-only lookup cannot launch a turn');
 const nextMeta=()=>({requestId:crypto.randomUUID(),expectedStateRevision:repository.state(repository.authenticate(human.token),scope).stateRevision});
 let journey=(await (await post('ui_claim_detail',{claimId:lesson.id})).json()).journey;assert.equal(journey.outcomes.length,1);assert.equal(journey.outcomes[0].id,final.results[0].id);assert.equal(journey.outcomes[0].review,null,'工具成功不冒充业务通过');
 const reviewInput={...nextMeta(),resultId:final.results[0].id,status:'needs_revision',note:'交付仍缺说明，请继续修改。'};assert.equal((await post('ui_review_result',reviewInput)).status,200);journey=(await (await post('ui_claim_detail',{claimId:lesson.id})).json()).journey;assert.equal(journey.outcomes[0].review.status,'needs_revision');assert.equal(journey.outcomes[0].review.note,reviewInput.note);assert.equal(journey.current.length,0);
 const plan=await (await post('ui_create_task_plan',{...nextMeta(),baseRunId:prep.run.id,baseResultId:final.results[0].id,plan:{title:'成果修改',nodes:[{id:'revise',title:'修改成果',instruction:'补齐说明，保留真实原文。',acceptanceCriteria:['修改后仍可下载'],dependsOn:[],sideEffect:'isolated_files'}]}})).json();
 const revisionResponse=await post('ui_prepare_step',{...nextMeta(),planId:plan.id,nodeId:'revise',instruction:'补齐口径说明。',baseResultId:final.results[0].id});assert.equal(revisionResponse.status,200);const revision=await revisionResponse.json();
 const revisedInput={...nextMeta(),runId:revision.run.id},revisedGrant=await (await post('authorize_execution',revisedInput)).json();
 const revised=await (await post('execute_task',{...revisedInput,authorizationId:revisedGrant.authorizationId})).json();await execution.idle();
 const revisedFinal=await (await post('execution_state',{operationId:revised.operation.id})).json();assert.equal(revisedFinal.operation.status,'succeeded');assert.equal(turns,2);
 assert.equal(revisedFinal.results[0].artifacts.length,1,'Input copies are not new artifacts');assert.equal(seen.taskInputs[0].resultId,final.results[0].id);
 assert.equal(repository.artifactFile(repository.authenticate(human.token),scope,final.results[0].id,artifact.id).bytes.toString().includes('真正的合成文件'),true);
 const preview=await post('ui_artifact_preview',{resultId:final.results[0].id,artifactId:artifact.id});assert.equal(preview.status,200);const projected=await preview.json();assert.equal(projected.status,'complete');assert.equal(projected.text,repository.artifactFile(repository.authenticate(human.token),scope,final.results[0].id,artifact.id).bytes.toString());
 const versions=await post('ui_result_versions',{resultId:revisedFinal.results[0].id});assert.equal(versions.status,200);const lineage=await versions.json();assert.equal(lineage.complete,true);assert.equal(lineage.versionCount,2);assert.deepEqual(new Set(lineage.versions.map(r=>r.id)),new Set([final.results[0].id,revisedFinal.results[0].id]));assert.ok(lineage.versions.every(r=>r.artifacts[0].saved));
 assert.equal((await post('ui_result_versions',{resultId:final.results[0].id,scope:{...scope,projectId:'foreign'}})).status,403);
 assert.equal((await post('ui_artifact_preview',{resultId:final.results[0].id,artifactId:artifact.id},{Authorization:'Bearer '+agent.token})).status,403);
 assert.equal((await post('ui_artifact_preview',{resultId:revisedFinal.results[0].id,artifactId:artifact.id})).status,503,'不同版本不能借用前版文件身份');

 // A changed on-disk file cannot be reaccepted after a restart/reconciliation.
 const journal=JSON.parse(readFileSync(join(dataDir,'codex',initial.operation.id,'executor.json')));assert.equal(journal.threadId,'isolated-thread');
 writeFileSync(join(dataDir,'codex',initial.operation.id,'workspace','交付.md'),'篡改内容');await assert.rejects(adapter.lookup({operationId:initial.operation.id,attemptId:final.attempt.id}));
 const blocked=await post('execution_state',{operationId:initial.operation.id}, {Origin:'https://evil.invalid'});assert.equal(blocked.status,403);
 const ledger=repository.usageLedger(repository.authenticate(human.token),scope);
 await app.close();repository.close();closed=true;
 const tokenFile=join(dataDir,'ui-token'),agentFile=join(dataDir,'agent-token');writeFileSync(tokenFile,human.token,{mode:0o600});writeFileSync(agentFile,agent.token,{mode:0o600});writeFileSync(join(dataDir,'connection.json'),JSON.stringify({endpoint,scope,uiTokenFile:tokenFile,agentTokenFile:agentFile}),{mode:0o600});
 const snapshot=await snapshotWorkspace(dataDir,backupDir);assert.ok(snapshot.data.counts.some(c=>c.kind==='artifact_file'&&c.total===2));restoreWorkspace(backupDir,restoredDir,{port:Number(new URL(endpoint).port)});
 const restoredRepo=new WorkspaceRepository({dataDir:restoredDir}),restoredAuth=restoredRepo.authenticate(human.token);try{assert.match(restoredRepo.artifactFile(restoredAuth,scope,final.results[0].id,artifact.id).bytes.toString(),/真正的合成文件/);assert.deepEqual(restoredRepo.usageLedger(restoredAuth,scope),ledger);assert.equal(restoredRepo.list(restoredAuth,scope,'result_review')[0].note,reviewInput.note);}finally{restoredRepo.close();}
});
