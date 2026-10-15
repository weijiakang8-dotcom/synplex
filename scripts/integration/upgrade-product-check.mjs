import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createServer} from 'node:net';
import {spawnSync} from 'node:child_process';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {supervise,settings} from '../runtime/workspace.mjs';
import {initializeInstallation,upgradeInstallation,rollbackInstallation,openInstallation} from '../runtime/upgrade.mjs';
import {inspectDatabase} from '../runtime/recovery.mjs';
import {randomUUID} from 'node:crypto';

const [first,second,evidenceInput]=process.argv.slice(2),evidence=resolve(evidenceInput);mkdirSync(evidence,{mode:0o700});
const dataDir=join(evidence,'workspace'),installation=join(evidence,'installation'),socket=createServer();await new Promise(yes=>socket.listen(0,'127.0.0.1',yes));const port=socket.address().port;await new Promise(yes=>socket.close(yes));
const events=[];let managed;
const ready=async count=>{const deadline=Date.now()+15000;while(events.length<count&&Date.now()<deadline)await new Promise(yes=>setTimeout(yes,20));assert.ok(events.length>=count,'missing readiness');assert.equal(events[count-1].error,undefined);};
try{
 managed=await supervise(settings({dataDir,port}),{openBrowser:false,onReady:e=>events.push(e)});await ready(1);await managed.close();
 const connection=JSON.parse(readFileSync(join(dataDir,'connection.json'),'utf8')),repository=new WorkspaceRepository({dataDir}),auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim()),repo=await repository.forScope(auth,connection.scope);
 const file=(await repo.saveBlob({bytes:Buffer.from('真实发行切换期间必须保留这份原件。'),format:'text/plain'},{requestId:'upgrade-product-source',expectedStateRevision:0})).value;repository.close();
 const before=inspectDatabase(join(dataDir,'workspace.sqlite'));await initializeInstallation(installation,first,dataDir);
 for(const name of ['打开Synplex.command','升级工作台.command','回退上一版.command'])assert.equal(spawnSync('/bin/zsh',['-n',join(installation,name)]).status,0);
 managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});await ready(2);assert.equal((await fetch(connection.endpoint+'/health')).status,200);await managed.close();assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),before);
 await upgradeInstallation(installation,second);managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});await ready(3);assert.equal((await fetch(connection.endpoint+'/health')).status,200);await managed.close();
 const later=new WorkspaceRepository({dataDir}),laterAuth=later.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim()),laterRepo=await later.forScope(laterAuth,connection.scope);await laterRepo.saveBlob({bytes:Buffer.from('切换以后新增的资料，回退也不能丢。'),format:'text/plain'},{requestId:'upgrade-product-later',expectedStateRevision:(await laterRepo.getState()).stateRevision});later.close();
 const latest=inspectDatabase(join(dataDir,'workspace.sqlite'));assert.notEqual(latest.contentHash,before.contentHash);
 await rollbackInstallation(installation);managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});await ready(4);assert.equal((await fetch(connection.endpoint+'/health')).status,200);await managed.close();assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),latest);
 const final=new WorkspaceRepository({dataDir}),finalAuth=final.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim());assert.equal(final.getBlob(finalAuth,connection.scope,file.id).blob.sha256,file.sha256);assert.equal(final.list(finalAuth,connection.scope,'attempt').length,0);final.close();
 let semanticGate=null;
 if(process.argv.includes('--require-semantic-gate')){
  await upgradeInstallation(installation,second);managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});await ready(5);
  const headers={Authorization:'Bearer '+readFileSync(connection.uiTokenFile,'utf8').trim(),'Content-Type':'application/json'};
  const post=async(method,body={})=>{const r=await fetch(connection.endpoint+'/api/v1/'+method,{method:'POST',headers,body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:connection.scope,...body})});assert.equal(r.status,200);return r.json();};
  const meta=async()=>({requestId:randomUUID(),expectedStateRevision:(await post('get_project_state')).stateRevision});
  const prepared=await post('prepare_task',{...await meta(),goal:'隔离发行验证，不执行模型',constraints:[],acceptanceCriteria:['只保存确定性测试说明'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:4000});
  const receipt=await post('record_result',{...await meta(),runId:prepared.run.id,result:{eventId:randomUUID(),attemptId:randomUUID(),provider:'free-package-fixture',summary:'这是确定性测试说明，不是模型完成的业务成果。',artifacts:[],checks:[],usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null}});
  const followup=await post('ui_prepare_followup',{...await meta(),resultId:receipt.result.id,question:'保留这轮说明，准备下个问题但不要执行。'});assert.equal(followup.conversation.rootRunId,prepared.run.id);await managed.close();
  const beforeGate=inspectDatabase(join(dataDir,'workspace.sqlite')),pointer=readFileSync(join(installation,'installation.json'));
  await assert.rejects(rollbackInstallation(installation),/不能完整理解/);assert.deepEqual(readFileSync(join(installation,'installation.json')),pointer);assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),beforeGate);
  const launch=spawnSync('/bin/zsh',[join(installation,'回退上一版.command')],{input:'\n',encoding:'utf8',timeout:10000});assert.equal(launch.status,1);assert.match(launch.stderr,/不能完整理解/);assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),beforeGate);
  managed=await openInstallation(installation,{openBrowser:false,onReady:e=>events.push(e)});await ready(6);const restored=await post('ui_task_detail',{runId:followup.run.id});assert.equal(restored.conversation.currentQuestion,'保留这轮说明，准备下个问题但不要执行。');await managed.close();
  semanticGate={rollbackRefusedBeforeSwitch:true,launcherRefusedBeforeSwitch:true,newestPackageReopened:true,followupPreserved:true,dataHash:beforeGate.contentHash,fixtureHostReceipts:1,modelExecutions:0};
 }
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['real packaged release initializes from stopped data','private disabled clone doctor','generated Mac launchers parse','first packaged server opens and closes','second packaged server opens after atomic switch','rollback starts first package with newer business records intact','original file SHA remains','no executor attempt before optional host fixture'],beforeHash:before.contentHash,afterHash:latest.contentHash,port,semanticGate,engineUpgradeVerified:false,modelCalls:0},null,2),{mode:0o600,flag:'wx'});
 console.log('两份真实发行包的安装、启动、程序切换与保留新资料的回退通过；未启动引擎或模型。');
}finally{await managed?.close();}
