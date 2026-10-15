// Manual native-keyboard acceptance fixture. No model, production data or host profile.
// Open the printed loopback page with the native browser; do not emulate composition.
import {cpSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {ExecutionCoordinator} from '../../services/workspace/execution.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import * as context from '../../packages/context/index.mjs';

const directory=resolve(process.argv[2]??`.runtime/implementation-baseline/native-ime-${randomUUID()}`);
const sourceCommit=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
const sourceDirty=execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().length>0;
mkdirSync(directory,{mode:0o700});
const dataDir=join(directory,'private-data'),publicDir=join(directory,'public');
cpSync(resolve('public'),publicDir,{recursive:true});
const repository=new WorkspaceRepository({dataDir}),scope={projectId:'native-ime-fixture',versionId:null,branchId:null};
const caps=['read_memory','write_memory','review_memory','prepare_task','record_result','execute'];
const human=repository.createCredential({ownerId:'native-ime-fixture',actorId:'human',scope,kind:'ui',capabilities:caps});
const host=repository.createCredential({ownerId:'native-ime-fixture',actorId:'fixture-host',scope,kind:'agent',capabilities:caps.filter(x=>!['review_memory','execute'].includes(x))});
const rootAuth=repository.authenticate(human.token),connection={scope,uiTokenFile:join(dataDir,'ui-token'),agentTokenFile:join(dataDir,'agent-token')};
writeFileSync(connection.uiTokenFile,human.token,{mode:0o600});writeFileSync(connection.agentTokenFile,host.token,{mode:0o600});
const localProjects=new LocalProjects({repository,dataDir,connection,rootAuth,allowExecution:true});
let executions=0,deliveries=0,events=[];
const adapter={mode:'platform_owned',async execute(input){
 executions++;
 const answer=await input.requestInput({remoteRequestId:randomUUID(),threadId:randomUUID(),turnId:randomUUID(),itemId:randomUUID(),questions:[{id:'format',header:'内容',question:'这份测试报告写什么？',isSecret:false,isOther:true,options:[]}]});
 if(!answer)throw Error('Native fixture answer not received');
 deliveries++;input.inputDelivered(answer.questionId);
 return {status:'succeeded',result:{eventId:input.operationId,attemptId:input.attemptId,provider:'native-ime-fixture',summary:'输入法测试已完成；没有调用模型。',artifacts:[],checks:[],usage:{observationScope:'host_unavailable',provider:null,model:null,inputTokens:null,outputTokens:null,cachedInputTokens:null,costUsd:null,pricingRevision:null,provenance:'unknown'},supersedesResultId:null,occurredAt:null}};
}};
const execution=new ExecutionCoordinator({repository,adapters:{synplex:adapter}});
const app=createWorkspaceServer({repository,localProjects,modules:{context},execution,publicDir});
const original=app.server.listeners('request')[0];app.server.removeAllListeners('request');
async function report(){
 const projects=await localProjects.list(rootAuth),snapshots=[];
 for(const project of projects){const selected=await localProjects.select(rootAuth,project.scope);snapshots.push({name:project.name,attempts:repository.list(selected.auth,selected.scope,'attempt').map(x=>({id:x.id,status:x.status})),questions:repository.list(selected.auth,selected.scope,'execution_question').map(x=>({id:x.id,status:x.status,delivery:x.delivery})),runs:repository.list(selected.auth,selected.scope,'run').length});}
 return {format:'synplex.native-ime-session/1',sourceCommit,sourceDirty,modelCalls:0,fixtureExecutions:executions,answerDeliveries:deliveries,projects:snapshots,events};
}
app.server.on('request',async(req,res)=>{
 if(!req.url.startsWith('/fixture/'))return original(req,res);
 const origin=`http://127.0.0.1:${app.server.address().port}`;
 if(req.headers.host!==new URL(origin).host||(req.headers.origin&&req.headers.origin!==origin)){res.writeHead(403);return res.end();}
 res.setHeader('Cache-Control','no-store');
 if(req.method==='GET'&&req.url==='/fixture/start'){
  const pair=await app.createUiPairing(rootAuth,scope);res.setHeader('Content-Type','text/html; charset=utf-8');
  return res.end(`<!doctype html><html lang="zh-CN"><title>Synplex · 隔离输入法测试</title><h1>隔离输入法测试</h1><p>这里只使用合成项目，不连接模型或真实项目。</p><form method="post" action="/api/v1/ui_pair"><input type="hidden" name="pair" value="${pair.nonce}"><button>进入测试项目</button></form></html>`);
 }
 if(req.method==='POST'&&req.url==='/fixture/events'){
  let body='';for await(const chunk of req){body+=chunk;if(body.length>4096){res.writeHead(413);return res.end();}}
  try{const batch=JSON.parse(body);if(!Array.isArray(batch)||batch.length>20)throw Error('invalid');
   for(const e of batch){if(!['compositionstart','compositionend','enter','submit'].includes(e.kind)||typeof e.form!=='string'||e.form.length>80)throw Error('invalid');events.push({at:new Date().toISOString(),kind:e.kind,form:e.form,field:typeof e.field==='string'?e.field.slice(0,80):null,isComposing:e.isComposing===true,keyCode:Number.isInteger(e.keyCode)?e.keyCode:null,defaultPrevented:e.defaultPrevented===true});}
   writeFileSync(join(directory,'observations.json'),JSON.stringify(await report(),null,2),{mode:0o600});res.writeHead(204);return res.end();
  }catch{res.writeHead(400);return res.end();}
 }
 if(req.method==='GET'&&req.url==='/fixture/state'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(await report(),null,2));}
 res.writeHead(404);res.end();
});
writeFileSync(join(publicDir,'native-ime-observer.js'),`
const observe=event=>{
 const field=event.target.closest('input,textarea'),form=event.type==='submit'?event.target:field?.form;if(!form)return;
 const kind=event.type==='keydown'?(event.key==='Enter'?'enter':null):event.type;if(!kind)return;
 const record={kind,form:form.id||form.className,field:field?.name,isComposing:event.isComposing===true,keyCode:event.keyCode};
 queueMicrotask(()=>{record.defaultPrevented=event.defaultPrevented;fetch('/fixture/events',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify([record])}).catch(()=>{});});
};
for(const type of ['compositionstart','compositionend','keydown','submit'])window.addEventListener(type,observe,true);
`);
const index=join(publicDir,'index.html');writeFileSync(index,readFileSync(index,'utf8').replace('<script src="/app.js"','<script src="/native-ime-observer.js" type="module"></script><script src="/app.js"'));
const url=await app.listen();connection.endpoint=url;localProjects.endpoint=url;
writeFileSync(join(directory,'session.json'),JSON.stringify({pid:process.pid,url,start:url+'/fixture/start',modelCalls:0,sourceCommit,sourceDirty,scope:'Private native keyboard fixture; not model or whole product acceptance'},null,2),{mode:0o600});
console.log(JSON.stringify({url,start:url+'/fixture/start',evidence:directory,modelCalls:0}));
let closing=false;
async function close(){if(closing)return;closing=true;writeFileSync(join(directory,'final-state.json'),JSON.stringify(await report(),null,2),{mode:0o600});await execution.close();await app.close();repository.close();}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>close().then(()=>process.exit(0)));
