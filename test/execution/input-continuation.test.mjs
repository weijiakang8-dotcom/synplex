import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EventEmitter} from 'node:events';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createCodexExecutor} from '../../adapters/execution/codex.mjs';
import * as context from '../../packages/context/index.mjs';
const protocolVersion='synplex.workspace/1.0.0',scope={projectId:'question-fixture',versionId:null,branchId:null};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function fixture(t,selection){
 const dir=mkdtempSync(join(tmpdir(),'synplex-question-')),repository=new WorkspaceRepository({dataDir:dir});
 const caps=['read_memory','write_memory','prepare_task','record_result','execute','review_memory'];
 const human=repository.createCredential({ownerId:'owner',actorId:'human',scope,kind:'ui',capabilities:caps});
 const agent=repository.createCredential({ownerId:'owner',actorId:'host',scope,capabilities:caps.filter(c=>c!=='review_memory')});
 const calls=[],params=[],replies=[];let rpc;
 class Rpc extends EventEmitter{
  async connect(){}close(){}
  async call(method,p){calls.push(method);params.push({method,p});
   if(method==='thread/start')return {thread:{id:'thread-exact'}};
   if(method==='turn/start'){setTimeout(()=>this.emit('request',{id:17,method:'item/tool/requestUserInput',params:{threadId:'thread-exact',turnId:'turn-exact',itemId:'item-exact',questions:[{id:'format',header:'格式',question:'你需要什么格式？',isSecret:false,isOther:true,options:[{label:'PDF',description:'方便阅读'},{label:'Markdown',description:'可编辑'}]}]}}),0);return {turn:{id:'turn-exact'}};}
   if(method==='turn/interrupt'){this.emit('notification',{method:'serverRequest/resolved',params:{threadId:'thread-exact',requestId:17}});this.emit('notification',{method:'turn/completed',params:{threadId:'thread-exact',turn:{id:'turn-exact',status:'interrupted'}}});return {};}
   throw new Error(method);
  }
  respond(id,result){replies.push({id,result});setTimeout(()=>this.emit('notification',{method:'turn/completed',params:{threadId:'thread-exact',turn:{id:'turn-exact',status:'completed'}}}),0);}
 }
 const adapter=createCodexExecutor({binary:'/fixture/codex',home:dir,dataDir:join(dir,'runs'),model:'fixture',provider:'fixture',allowedModels:[{id:'fixture',efforts:['low']},{id:'other-model',provider:'other-provider',label:'另一个型号',efforts:['high']}],rpcFactory:()=>rpc=new Rpc()});
 assert.throws(()=>adapter.validateSelection({model:'not-connected',effort:'high'}),{code:'capability_unavailable'});
 assert.equal(calls.length,0);
 const managedAdapter={...adapter,execute(input){
  if(input.packet.goal==='后续独立任务')return Promise.resolve({status:'succeeded',result:{eventId:'fixture:'+input.operationId,attemptId:input.attemptId,provider:'fixture',summary:'后续独立任务已完成。',artifacts:[],checks:[],usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null},files:[]});
  return adapter.execute(input);
 }};
 const execution=new ExecutionCoordinator({repository,adapters:{codex:managedAdapter},timeoutMs:100,inputTimeoutMs:3000,leaseMs:1000});
 const app=createWorkspaceServer({repository,modules:{context},execution}),endpoint=await app.listen();
 t.after(async()=>{await execution.idle();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});});
 const post=(path,input,token=human.token)=>fetch(endpoint+'/api/v1/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({protocolVersion,scope,...input})});
 const prepared=await (await post('prepare_task',{requestId:'prepare',expectedStateRevision:0,goal:'交付一份说明文件',constraints:['不付款'],acceptanceCriteria:['明确说明文件格式'],mode:'delegated',executor:'codex',selectedOccurrenceIds:[],maxInputTokens:4000,...(selection?{executionOptions:selection}:{})})).json();
 if(selection)assert.deepEqual(prepared.packet.executionOptions,selection);
 const req={requestId:'start-once',expectedStateRevision:0,runId:prepared.run.id};
 const grant=await (await post('authorize_execution',req)).json();const started=await (await post('execute_task',{...req,authorizationId:grant.authorizationId})).json();
 const state=()=>repository.executionState(repository.authenticate(human.token),scope,started.operation.id);
 for(let i=0;i<100&&!state().questions.length;i++)await pause(5);
 assert.equal(state().questions.length,1);
 return {repository,human,agent,execution,post,state,calls,params,replies,get rpc(){return rpc;},question:state().questions[0]};
}
test('HTTP answer continues the exact Codex request, persists the answer and never starts a second turn',async t=>{
 const f=await fixture(t,{model:'other-model',effort:'high'});await pause(150);
 assert.equal(f.params[0].p.model,'other-model');assert.equal(f.params[0].p.modelProvider,'other-provider');
 assert.equal(f.params[1].p.model,'other-model');assert.equal(f.params[1].p.effort,'high');
 assert.equal(f.state().operation.status,'running','human wait does not consume the normal execution timeout');
 const answer={requestId:'answer-once',expectedStateRevision:0,questionId:f.question.id,answers:{format:{answers:['PDF']}}};
 assert.equal((await f.post('ui_answer_question',answer,f.agent.token)).status,403);
 assert.equal((await f.post('ui_answer_question',{...answer,questionId:'foreign'})).status,409);
 assert.equal((await f.post('ui_answer_question',{...answer,answers:{wrong:{answers:['PDF']}}})).status,400);
 assert.equal((await f.post('ui_answer_question',answer)).status,200);await f.execution.idle();
 assert.equal((await f.post('ui_answer_question',answer)).status,200,'exact replay only returns the original receipt');
 assert.equal((await f.post('ui_answer_question',{...answer,answers:{format:{answers:['Markdown']}}})).status,409);
 assert.deepEqual(f.calls,['thread/start','turn/start']);assert.deepEqual(f.replies,[{id:17,result:{answers:{format:{answers:['PDF']}}}}]);
 assert.equal(f.state().questions[0].delivery,'sent');assert.equal(f.state().questions[0].answeredBy,'human');
 assert.equal(f.state().operation.status,'succeeded');assert.equal(f.state().results[0].usage.costUsd,null);
 assert.equal(f.state().results[0].usage.model,'other-model');assert.equal(f.state().results[0].usage.provider,'other-provider');
});
test('a cleared or cancelled server question cannot be answered or secretly restarted',async t=>{
 const f=await fixture(t);
 f.rpc.emit('notification',{method:'serverRequest/resolved',params:{threadId:'thread-exact',requestId:17}});
 await pause(5);assert.equal(f.state().questions[0].status,'unavailable');
 assert.equal((await f.post('ui_answer_question',{requestId:'late',expectedStateRevision:0,questionId:f.question.id,answers:{format:{answers:['PDF']}}})).status,409);
 await f.post('cancel_execution',{operationId:f.state().operation.id});await f.execution.idle();
 assert.equal(f.state().operation.status,'cancelled');assert.equal(f.replies.length,0);assert.equal(f.calls.filter(c=>c==='turn/start').length,1);
});

test('a human wait yields the serial slot, and answering resumes the original task after independent work',async t=>{
 const f=await fixture(t),auth=f.repository.authenticate(f.human.token);
 const revision=()=>f.repository.state(auth,scope).stateRevision;
 const prepared=await (await f.post('prepare_task',{requestId:'followup-prepare',expectedStateRevision:revision(),goal:'后续独立任务',constraints:[],acceptanceCriteria:['保留第一项等待'],mode:'delegated',executor:'codex',selectedOccurrenceIds:[],maxInputTokens:4000})).json();
 const req={requestId:'followup-start',expectedStateRevision:revision(),runId:prepared.run.id};
 const grant=await (await f.post('authorize_execution',req)).json();
 const response=await f.post('execute_task',{...req,authorizationId:grant.authorizationId});assert.equal(response.status,202);
 const second=await response.json();
 for(let i=0;i<100&&f.repository.executionState(auth,scope,second.operation.id).operation.status!=='succeeded';i++)await pause(5);
 assert.equal(f.repository.executionState(auth,scope,second.operation.id).operation.status,'succeeded');
 assert.equal(f.state().questions[0].status,'pending');assert.equal(f.replies.length,0);
 assert.equal((await f.post('ui_answer_question',{requestId:'after-followup',expectedStateRevision:revision(),questionId:f.question.id,answers:{format:{answers:['PDF']}}})).status,200);
 await f.execution.idle();assert.equal(f.state().operation.status,'succeeded');
 assert.equal(f.replies.length,1);assert.equal(f.calls.filter(x=>x==='turn/start').length,1);
});
