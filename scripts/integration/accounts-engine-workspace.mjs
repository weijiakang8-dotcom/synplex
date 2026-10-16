import {snapshotWorkspace,restoreWorkspace} from '../runtime/recovery.mjs';
import {inspectRestoredBindings} from '../runtime/recovery-bindings.mjs';
// Two genuine account sessions -> separate AgentHub organizations -> actual
// queue workers and Word files. Provider and email replies are synthetic only.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createTenantAgentHubExecutor} from '../../adapters/execution/tenant-agenthub.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createAccounts} from '../../services/workspace/accounts.mjs';
import {modelChoiceId} from '../../services/workspace/model-relay.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';
const root=resolve(process.argv[2]),port=Number(process.argv[3]),data=JSON.parse(readFileSync(join(root,'engine','engine','bootstrap.json'))),workspace=join(root,'workspace');
mkdirSync(workspace,{mode:0o700});const repository=new WorkspaceRepository({dataDir:workspace}),scope={projectId:'legacy',branchId:null,versionId:null};
const initial=initialConnection(repository,{dataDir:workspace,port,scope}),rootAuth=repository.authenticate(readFileSync(initial.uiTokenFile,'utf8'));
const projects=new LocalProjects({repository,dataDir:workspace,connection:initial,rootAuth,allowExecution:true}),mail=[],calls=[];
const config={name:'隔离合成连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:1024,models:[{id:'fixture-execution-model',name:'合成执行型号',capabilities:{tools:true,stream:true,efforts:['high'],contextWindow:64000}}]};
const manuscript='# 合成计划\n\n目标：核对真实文件交付。\n\n步骤：先确认资料，再生成文件，最后核对下载。\n\n验收：原文件可下载，历史不丢失。';
const relay=repository.modelRelay({transport:async input=>{
  assert.equal(input.secret,'synthetic-never-valid-provider-key');assert.equal(input.body.model,'fixture-execution-model');assert.equal(input.body.reasoning_effort,'high');
  calls.push({model:input.body.model,effort:input.body.reasoning_effort,roles:input.body.messages.map(m=>m.role)});const messages=input.body.messages,system=messages.filter(m=>m.role==='system').map(m=>m.content).join('\n');
  let content,toolCalls;
  if(system.includes('意图路由器'))content=JSON.stringify({category:'TASK',complexity:'simple',confidence:1,reason:'隔离文档任务',requires_tool:true,requires_side_effect:false,requires_approval:false,requires_data:false,needs_knowledge:false,needs_web_search:false,memory_intent:'none',reference_target:null,multi_goal:false,reference_resolved:true,requested_deliverables:['artifact'],artifact_formats:['docx']});
  else if(system.includes('任务规划器'))content=JSON.stringify({goal:'生成合成Word计划',risk:'MEDIUM',feasibility:{possible:true,missing:[],continue_with:[]},deliverables:[{type:'artifact',what:'Word计划',done_when:'可下载真实docx文件'}],steps:[{step_id:'step_1',capability:'document',description:'将给定合成计划导出Word文件',input_refs:['user_input'],output_name:'计划',depends_on:[],artifact_formats:['docx'],document_title:'合成计划'}],reason:'单步导出'});
  else if(system.includes('只输出PASS或FAIL'))content='PASS';
  else if(input.body.tools?.some(t=>t.function?.name==='export_document')&&!messages.some(m=>m.role==='tool'))toolCalls=[{id:'call-fixture-export',type:'function',function:{name:'export_document',arguments:JSON.stringify({title:'合成计划',content:manuscript,format:'docx'})}}];
  else if(messages.some(m=>m.role==='tool'))content='已导出给定的Word计划，文件由实际工具生成。';
  else content=manuscript;
  const message=toolCalls?{role:'assistant',content:null,tool_calls:toolCalls}:{role:'assistant',content};
  const value={id:'fixture-call-'+calls.length,object:'chat.completion',created:1,model:input.body.model,choices:[{index:0,message,finish_reason:toolCalls?'tool_calls':'stop'}],usage:{prompt_tokens:30,completion_tokens:20,prompt_tokens_details:{cached_tokens:0}}};
  if(input.body.stream){input.onChunk(Buffer.from('data: '+JSON.stringify({...value,object:'chat.completion.chunk',choices:[{index:0,delta:toolCalls?{role:'assistant',tool_calls:toolCalls.map((t,index)=>({...t,index}))}:{role:'assistant',content},finish_reason:null}],usage:null})+'\n\ndata: '+JSON.stringify({...value,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:toolCalls?'tool_calls':'stop'}]})+'\n\ndata: [DONE]\n\n'));}
  else input.onChunk(Buffer.from(JSON.stringify(value)));
}});
const endpoint=`http://127.0.0.1:${port}`,adapter=createTenantAgentHubExecutor({relay,relayEndpoint:endpoint+'/internal/model/v1',endpoint:`http://127.0.0.1:${data.api_port}`,tokenFile:join(root,'engine','engine','access-token'),workflowId:data.workflow_id,dataDir:join(workspace,'executors','agenthub'),pollMs:100,requireWorkerReceipt:true});
writeFileSync(join(workspace,'executors.json'),JSON.stringify({synplex:{endpoint:`http://127.0.0.1:${data.api_port}`,tokenFile:join(root,'engine','engine','access-token'),workflowId:data.workflow_id,useModelConnections:true}}),{mode:0o600,flag:'wx'});
const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter},timeoutMs:90000});
const accounts=createAccounts({repository,dataDir:workspace,localProjects:projects,allowExecution:true,mailer:{ready:()=>true,send:async m=>mail.push(m)}});
const server=createWorkspaceServer({repository,localProjects:projects,accounts,modules:{context},execution,modelRelay:relay,modelAdmin:auth=>accounts.admin(auth)});
const protocolVersion='synplex.workspace/1.0.0';
async function raw(action,input,cookie){const response=await fetch(endpoint+'/api/v1/'+action,{method:'POST',headers:{Cookie:cookie??'','Content-Type':'application/json'},body:JSON.stringify(input)});return {response,body:await response.json()};}
const users=[];
try{
 await server.listen(port);
 for(const name of ['alice','bob']){
  const email=name+'@example.com';assert.equal((await raw('auth/send-code',{email})).response.status,200);
  const registered=await raw('auth/register',{email,password:'synthetic-password',code:mail.at(-1).text.match(/\d{6}/)[0]});assert.equal(registered.response.status,201,JSON.stringify(registered.body));
  const cookie=registered.response.headers.get('set-cookie').split(';')[0],bootstrap=await fetch(endpoint+'/api/v1/ui_bootstrap',{headers:{Cookie:cookie}}).then(r=>r.json()),current=bootstrap.scope;
  const post=async(action,extra={})=>{const value=await raw(action,{protocolVersion,scope:current,...extra},cookie);assert.ok(value.response.ok,JSON.stringify({status:value.response.status,body:value.body}));return value.body;};
  const saved=await post('ui_save_model',{requestId:'save',kind:'personal',config,secret:'synthetic-never-valid-provider-key'});
  const prepared=await post('prepare_task',{requestId:'prepare',expectedStateRevision:0,goal:'生成可下载的Word计划，正文如下：\n'+manuscript,constraints:['只使用给定合成材料','不得请求外部网络'],acceptanceCriteria:['Word可下载且包含核对真实文件交付'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:6000,executionOptions:{model:modelChoiceId(saved.connection.id,'fixture-execution-model'),effort:'high'}});
  const before=await post('ui_history'),input={requestId:'execute',expectedStateRevision:before.state.stateRevision,runId:prepared.run.id},grant=await post('authorize_execution',input),request={...input,authorizationId:grant.authorizationId};
  const started=await post('execute_task',request);await execution.idle();const state=await post('execution_state',{operationId:started.operation.id});
  assert.equal(state.operation.status,'succeeded',JSON.stringify({operation:state.operation,activity:state.activity.slice(-8),results:state.results}));
  const result=state.results[0],artifact=result.artifacts.find(a=>a.name.endsWith('.docx'));assert.ok(artifact);
  const response=await fetch(endpoint+'/api/v1/artifact_file',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion,scope:current,resultId:result.id,artifactId:artifact.id})});assert.equal(response.status,200);
  const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha256(bytes),artifact.sha256);assert.match(strFromU8(unzipSync(bytes)['word/document.xml']),/核对真实文件交付/);
  const count=calls.length;assert.equal((await post('execute_task',request)).operation.id,started.operation.id);assert.equal(calls.length,count);
  users.push({cookie,scope:current,operationId:started.operation.id,resultId:result.id,artifactId:artifact.id,artifactSha256:artifact.sha256});
 }
 for(const [user,other] of [[users[0],users[1]],[users[1],users[0]]]){
  for(const [action,extra] of [['execution_state',{operationId:other.operationId}],['artifact_file',{resultId:other.resultId,artifactId:other.artifactId}],['ui_select_project',{}]]){
   const result=await raw(action,{protocolVersion,scope:other.scope,...extra},user.cookie);assert.equal(result.response.status,403,JSON.stringify(result.body));
  }
 }
 const bindings=users.map(user=>JSON.parse(readFileSync(join(workspace,'executors','agenthub','tenant-bindings',user.operationId+'.json'),'utf8')));
 assert.notEqual(bindings[0].ownerId,bindings[1].ownerId);
 writeFileSync(join(root,'result.json'),JSON.stringify({source:'two email-verified synthetic accounts, real Node/SQLite/isolated Python/PG/Valkey/Celery/DOCX; no external email or model network',modelCalls:0,fixtureRequests:calls.length,accounts:users.map(({cookie,...user})=>user),checks:['real account cookies, separate owners and AgentHub organizations','personal model selection reaches all worker calls','two actual DOCX downloads with hashes','cross-account task/file/project access denied','exact replay never dispatches twice']},null,2),{mode:0o600,flag:'wx'});
 console.log('两账号到独立组织、真实执行队列和Word成果链路通过；真实模型调用0。');
}finally{await server.close();repository.close();}

const snapshot=join(root,'workspace-snapshot'),restored=join(root,'workspace-restored');await snapshotWorkspace(workspace,snapshot);restoreWorkspace(snapshot,restored,{port:port+1>65535?port-1:port+1});
const report=inspectRestoredBindings(snapshot,restored,join(root,'engine'),join(root,'engine','engine','bootstrap.json'));assert.equal(report.bindings.length,2);assert.ok(report.bindings.every(row=>row.state==='ready_to_inspect'&&row.engineIdentity));writeFileSync(join(root,'bindings.json'),JSON.stringify(report,null,2),{flag:'wx',mode:0o600});console.log('账号项目、会话和原执行绑定的离线备份恢复核对通过，未启用恢复副本。');
