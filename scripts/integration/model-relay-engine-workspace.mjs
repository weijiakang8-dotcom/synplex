// Complete real Node/SQLite -> Python/API/PG/queue/worker -> document file path.
// Only provider replies are fixtures; no provider address is contacted.
import assert from 'node:assert/strict';
import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {unzipSync,strFromU8} from 'fflate';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createModelConnectionExecutor} from '../../adapters/execution/model-connections.mjs';
import {modelChoiceId} from '../../services/workspace/model-relay.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';
import * as context from '../../packages/context/index.mjs';

const root=resolve(process.argv[2]),port=Number(process.argv[3]),data=JSON.parse(readFileSync(join(root,'engine','engine','bootstrap.json'))),workspace=join(root,'workspace');
mkdirSync(workspace,{mode:0o700});const repository=new WorkspaceRepository({dataDir:workspace}),scope={projectId:'relay-isolated',branchId:null,versionId:null};
const cred=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result','execute']}),auth=repository.authenticate(cred.token),calls=[];
const config={name:'隔离合成连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:1024,models:[{id:'fixture-execution-model',name:'合成执行型号',capabilities:{tools:true,stream:true,efforts:['high'],contextWindow:64000}}]};
const connection=repository.models(auth,scope).save({requestId:'save-fixture',config,secret:'synthetic-never-valid-provider-key'});
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
const endpoint=`http://127.0.0.1:${port}`,adapter=createModelConnectionExecutor({relay,relayEndpoint:endpoint+'/internal/model/v1',endpoint:`http://127.0.0.1:${data.api_port}`,tokenFile:join(root,'engine','engine','access-token'),workflowId:data.workflow_id,dataDir:join(workspace,'executors','agenthub'),pollMs:100,requireWorkerReceipt:true});
const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter},timeoutMs:90000}),server=createWorkspaceServer({repository,modules:{context},execution,modelRelay:relay});
try{
  await server.listen(port);const post=async(action,input)=>{const r=await fetch(endpoint+'/api/v1/'+action,{method:'POST',headers:{Authorization:'Bearer '+cred.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,...input})});const value=await r.json();assert.ok(r.ok,JSON.stringify({status:r.status,value}));return value;};
  const revision=()=>repository.state(auth,scope).stateRevision;
  const prepared=await post('prepare_task',{requestId:'prepare-fixture',expectedStateRevision:revision(),goal:'生成可下载的Word计划，正文如下：\n'+manuscript,constraints:['只使用给定合成材料','不得请求外部网络'],acceptanceCriteria:['Word可下载且包含核对真实文件交付'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:6000,executionOptions:{model:modelChoiceId(connection.id,'fixture-execution-model'),effort:'high'}});
  const input={requestId:'execute-fixture',expectedStateRevision:revision(),runId:prepared.run.id},authorization=await post('authorize_execution',input),request={...input,authorizationId:authorization.authorizationId};
  const started=await post('execute_task',request);await execution.idle();const state=await post('execution_state',{operationId:started.operation.id});
  writeFileSync(join(root,'task-state.json'),JSON.stringify(state,null,2),{mode:0o600,flag:'wx'});assert.equal(state.operation.status,'succeeded',JSON.stringify({operation:state.operation,activity:state.activity.slice(-5),results:state.results}));
  const result=state.results[0],artifact=result.artifacts.find(a=>a.name.endsWith('.docx'));assert.ok(artifact,'missing actual DOCX');
  const response=await fetch(endpoint+'/api/v1/artifact_file',{method:'POST',headers:{Authorization:'Bearer '+cred.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,resultId:result.id,artifactId:artifact.id})});assert.equal(response.status,200);const bytes=Buffer.from(await response.arrayBuffer());assert.equal(sha256(bytes),artifact.sha256);assert.match(strFromU8(unzipSync(bytes)['word/document.xml']),/核对真实文件交付/);
  const before=calls.length;assert.equal((await post('execute_task',request)).operation.id,started.operation.id);assert.equal(calls.length,before);assert.ok(before>=3);assert.equal(result.usage.model,'fixture-execution-model');assert.equal(result.usage.inputTokens,before*30);assert.equal(result.usage.costUsd,null);
  const ledger=relay.calls(auth,scope,started.operation.id);assert.equal(ledger.length,before);assert.ok(ledger.every(c=>c.status==='completed'));
  writeFileSync(join(root,'result.json'),JSON.stringify({source:'real isolated Node/SQLite/Python/FastAPI/PostgreSQL/Valkey/Celery/document exporter; synthetic provider only',modelCalls:0,fixtureRequests:before,operationId:started.operation.id,artifact:{name:artifact.name,sha256:artifact.sha256,byteLength:bytes.length},checks:['personal model and effort reach all engine calls','real durable submit and worker return','actual Word archive and content via authenticated download','complete per-call unknown-cost ledger','exact execution replay has no new model request']},null,2),{mode:0o600,flag:'wx'});console.log('独立完整引擎及Word文件链路通过；真实模型调用0。');
}finally{await server.close();repository.close();}
