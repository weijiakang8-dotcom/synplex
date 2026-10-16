import {handleModelLedgerRoute} from './model-ledger-routes.mjs';
import {handleModelRelay} from './model-relay-http.mjs';
import {createChatRoutes} from './chat-routes.mjs';
import {uiSessionCookie,uiSessionCookieName} from './public-access.mjs';
import {beginRequestTrace,diagnosticStatus} from './diagnostics.mjs';
import {handleReadRoute} from './read-routes.mjs';
import {handleModelRoute} from './model-routes.mjs';
import {createExpressionLinks} from './expression-links.mjs';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep, extname } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { ProtocolError, PROTOCOL_VERSION, validateWire } from '../../packages/contracts/validate.mjs';
import { WorkspaceService, safeError } from './service.mjs';
import { verifyArtifact } from './artifacts.mjs';
import { buildDistribution } from '../../plugins/distribution.mjs';
import {isAccountPage} from '../../public/account-navigation.js';

const MiB = 1024 * 1024;
const statusFor = error => ({ validation_failed: 400, scope_denied: 403, conflict: 409, stale_context: 409,
  budget_exceeded: 413, capability_unavailable: 503, unsupported_format: 422, partial_parse: 422, writeback_pending: 409 })[error.code] ?? 500;
const wireFail = (code,message,nextAction,retry='never') => new ProtocolError(code,message,nextAction,retry);
const denied = () => wireFail('scope_denied','访问被拒绝。','使用获准的本机连接。');
function collect(req, limit) {
  return new Promise((resolve,reject) => {
    let total=0; const chunks=[];
    function clean() {req.off('data',data);req.off('end',end);req.off('error',error);req.off('aborted',aborted);}
    function error(e) {clean();reject(e);}
    function aborted() {error(wireFail('conflict','请求中断。','核对已有操作回执。','lookup_operation'));}
    function data(b) {
      total+=b.length;
      if(total>limit) {clean();req.pause();const e=wireFail('validation_failed','文件过大。','拆分资料后再提交。');e.httpStatus=413;reject(e);}
      else chunks.push(b);
    }
    function end() {clean();resolve(Buffer.concat(chunks,total));}
    req.on('data',data);req.on('end',end);req.on('error',error);req.on('aborted',aborted);
  });
}
function send(res,status,body,headers={}) {
  if(res.headersSent || res.destroyed) return;
  const bytes=Buffer.from(JSON.stringify(body));
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Content-Length':bytes.length,
    'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer',...headers});
  res.end(bytes);
}
function strictLocal(req, server, allowedOrigins) {
  const address=server.address();
  const hosts=new Set([`127.0.0.1:${address.port}`,`localhost:${address.port}`]);
  if(!hosts.has(req.headers.host) || !['127.0.0.1','::1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) throw denied();
  const origin=req.headers.origin;
  const privateLauncher=req.method==='POST'&&req.url==='/api/v1/ui_pair'&&origin==='null';
  if(origin && !privateLauncher && !new Set([...hosts].map(host=>`http://${host}`).concat(allowedOrigins)).has(origin)) throw denied();
}
async function parseJSON(req,limit=2*MiB) {
  if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']??'')) throw wireFail('validation_failed','需要JSON请求。','提供正确的Content-Type。');
  const bytes=await collect(req,limit);
  try {return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));}
  catch {throw wireFail('validation_failed','JSON或UTF-8无效。','修正格式，不要自动重发未知操作。');}
}
async function parseUpload(req,url) {
  if(!/^multipart\/form-data\s*;/i.test(req.headers['content-type']??'')) throw wireFail('validation_failed','需要文件上传格式。','使用metadata和source两个字段。');
  const bytes=await collect(req,67*MiB);
  let form;
  try {form=await new Request(url,{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:bytes}).formData();}
  catch {throw wireFail('validation_failed','上传格式无法读取。','重新导出正确的文件上传格式。');}
  if([...form.keys()].some(k=>!['metadata','source'].includes(k)) || form.getAll('metadata').length!==1 || form.getAll('source').length!==1) throw wireFail('validation_failed','上传字段缺失或重复。','仅提交一份metadata和一份source。');
  const metadata=form.get('metadata'),file=form.get('source');
  if(typeof metadata!=='string' || Buffer.byteLength(metadata)>2*MiB || typeof file?.arrayBuffer!=='function' || file.size>64*MiB) {
    const e=wireFail('validation_failed','文件或元数据超过限制。','原件最多64MiB，元数据最多2MiB。');e.httpStatus=413;throw e;
  }
  let input;
  try{input=JSON.parse(metadata);}catch{throw wireFail('validation_failed','元数据格式无效。','修正metadata JSON。');}
  validateWire('ImportMetadataRequest',input);
  return {metadata:input,bytes:new Uint8Array(await file.arrayBuffer())};
}

async function prepareTaskRoute(path,auth,input,service){
 const methods={'/api/v1/ui_prepare_step':'prepareStep','/api/v1/ui_prepare_followup':'prepareFollowup'};
 if(!Object.hasOwn(methods,path))return null;if(auth.kind!=='ui')throw denied();
 return service[methods[path]](auth,input);
}

function resultSelectionRoute(path,auth,input,repository){
 if(path!=='/api/v1/ui_adopt_task_result')return null;if(auth.kind!=='ui')throw denied();
 return repository.adoptTaskResult(auth,input).value;
}
async function servePrivateRoute({req,res,path,url,relay,expressionLinks}){
  return await handleModelRelay({req,res,path,relay,parseJSON,send})||expressionLinks.handle(req,res,url);
}

async function serveUiRoute(context,res,expressionLinks){
  const mutation=expressionLinks.mutate(context.path,context.auth,context.input);
  const reply=mutation??handleModelLedgerRoute(context)??await handleModelRoute(context)??await context.chatRoutes.handle(context)??await handleReadRoute(context);if(!reply)return false;
  if(reply.bytes){res.writeHead(200,reply.headers);res.end(reply.bytes);}
  else send(res,reply.status??200,reply.body);
  return true;
}

async function servePublicPage({req,res,path,publicDir,publicLanding}){
      if(req.method!=='GET'||path.startsWith('/api/')||!publicDir)return false;
        let relative;try{relative=decodeURIComponent(path==='/'?(publicLanding?'/home/index.html':'/index.html'):path==='/app'||path==='/app/'||isAccountPage({pathname:path,search:''})?'/index.html':path);}catch{throw wireFail('validation_failed','页面路径无效。','使用工作台入口。');}
        const root=resolve(publicDir),file=resolve(root,`.${relative}`);
        if(!file.startsWith(root+sep)) throw denied();
        const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.js':'text/javascript; charset=utf-8','.png':'image/png','.svg':'image/svg+xml'};
        if(!types[extname(file)]) throw denied();
        try{
          const bytes=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)],'X-Content-Type-Options':'nosniff',
            'Cache-Control':'no-store','Content-Security-Policy':"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"});res.end(bytes);return true;
        }catch(error){if(error.code==='ENOENT'){send(res,404,{error:'页面不存在。'});return true;}throw error;}
      }

async function accountRoute(accounts,args){
 if(accounts)return accounts.handle(args);
 if(args.req.method==='GET'&&args.path==='/api/v1/auth/status'){args.send(args.res,200,{enabled:false});return true;}
 return false;
}

async function browserSession(accounts,req,port,legacySession,localProjects){
 const uiSession=await accounts?.session(req,port)??legacySession(req),projectManager=uiSession?.projects??localProjects;
 if(uiSession&&projectManager)await projectManager.list(uiSession.rootAuth);
 return {uiSession,projectManager};
}

export function createWorkspaceServer({repository,modules={},publicDir=null,allowedOrigins=[],secureCookies=false,buildSha=null,importTimeoutMs=300_000,localProjects=null,execution=null,diagnostics=null,modelAdmin=null,chatTransport=undefined,modelRelay=null,publicLanding=false,accounts=null}) {
  const service=new WorkspaceService({repository,modules,importTimeoutMs});
  const expressionLinks=createExpressionLinks(repository);
  const chatRoutes=createChatRoutes({repository,execution,transport:chatTransport});
  const capabilityInfo=(auth=null,scope=null)=>({...service.capabilities(),modelConnections:true,chat:true,execution:!!execution?.executors().length,executors:execution?.executors(auth,scope)??[]});
  const pairings=new Map(),sessions=new Map();
  const pairingDenied=()=>{const error=denied();error.uiPairing=true;return error;};
  async function createUiPairing(auth,scope,rootAuth=auth){
    if(auth.kind!=='ui'||!auth.capabilities.has('review_memory'))throw denied();
    await repository.forScope(auth,scope);
    for(const [key,p] of pairings)if(p.expiresAt<Date.now())pairings.delete(key);
    const nonce=randomBytes(32).toString('hex');pairings.set(nonce,{nonce,auth,rootAuth,scope:structuredClone(scope),expiresAt:Date.now()+300_000});
    return {nonce,endpoint:`http://127.0.0.1:${server.address().port}`};
  }
  function session(req){
    const prefix=uiSessionCookieName(server.address().port)+'=';
    const id=(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(prefix))?.slice(prefix.length);
    const s=sessions.get(id);if(!s||s.expiresAt<Date.now()){sessions.delete(id);return null;}return s;
  }
  const server=http.createServer(async (req,res)=>{
    const trace=beginRequestTrace(req,res,diagnostics);
    try{
      strictLocal(req,server,allowedOrigins);
      const url=new URL(req.url,`http://${req.headers.host}`),path=url.pathname;
      if(req.method==='GET'&&path==='/health') return send(res,200,{ok:true,protocolVersion:PROTOCOL_VERSION,mode:'isolated-local-workspace',buildSha});
      if(await servePrivateRoute({req,res,path,url,relay:modelRelay,expressionLinks}))return;
      if(await servePublicPage({req,res,path,publicDir,publicLanding}))return;
      if(!path.startsWith('/api/v1/'))return send(res,404,{error:'接口不存在。'});
      if(await accountRoute(accounts,{req,res,path,port:server.address().port,parseJSON,send,legacySession:()=>session(req)}))return;
      if(req.method==='POST'&&path==='/api/v1/ui_pair'){
        if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']??''))throw denied();
        const body=new URLSearchParams((await collect(req,4096)).toString('utf8')),nonce=body.get('pair');
        if([...body.keys()].join(',')!=='pair'||!nonce||!/^[a-f0-9]{64}$/.test(nonce))throw pairingDenied();
        const entry=pairings.get(nonce);
        if(!entry||entry.expiresAt<Date.now()||!timingSafeEqual(Buffer.from(nonce),Buffer.from(entry.nonce)))throw pairingDenied();
        await repository.forScope(entry.auth,entry.scope);
        pairings.delete(nonce);const id=randomBytes(32).toString('hex');
        sessions.set(id,{auth:entry.auth,rootAuth:entry.rootAuth,scope:entry.scope,expiresAt:Date.now()+8*3600_000});
        res.writeHead(303,{'Location':publicLanding?'/app':'/','Cache-Control':'no-store','Referrer-Policy':'no-referrer',
          'Set-Cookie':uiSessionCookie(id,{secureCookies,port:server.address().port})});res.end();return;
      }
      const header=req.headers.authorization;
      const {uiSession,projectManager}=await browserSession(accounts,req,server.address().port,session,localProjects);
      if(!header?.startsWith('Bearer ')&&!uiSession)throw denied();
      const auth=header?.startsWith('Bearer ')?repository.authenticate(header.slice(7)):uiSession.auth;trace.actor(auth);
      if(req.method==='GET'&&path==='/api/v1/ui_bootstrap'){
        if(!uiSession||auth.kind!=='ui')throw denied();
        const repo=await repository.forScope(auth,uiSession.scope);
        return send(res,200,{scope:uiSession.scope,state:await repo.getState(),capabilities:capabilityInfo(auth,uiSession.scope),projects:projectManager?await projectManager.list(uiSession.rootAuth):null,...(accounts?{authentication:accounts.metadata(uiSession)}:{})});
      }
      if(req.method==='POST'&&path==='/api/v1/ui_logout'){
        if(uiSession?.sessionHash)throw wireFail('validation_failed','请从账号入口退出登录。','使用退出登录按钮。');
        if(uiSession){for(const [id,s] of sessions)if(s===uiSession)sessions.delete(id);}
        return send(res,200,{ok:true},{'Set-Cookie':uiSessionCookie('',{secureCookies,maxAge:0,port:server.address().port})});
      }
      if(req.method==='GET'&&path==='/api/v1/capabilities')return send(res,200,capabilityInfo(auth,auth.authorizedScope));
      if(req.method!=='POST')return send(res,405,{error:'请使用POST。'},{Allow:'POST'});
      const declared=req.headers['content-length'];
      const limit=['/api/v1/import_source','/api/v1/ui_verify_artifact'].includes(path)?67*MiB:2*MiB;
      if(declared&&(!/^\d+$/.test(declared)||Number(declared)>limit)) {
        const e=wireFail('validation_failed','请求超过大小限制。','拆分过大材料。');e.httpStatus=413;throw e;
      }
      if(path==='/api/v1/import_source') {
        if(auth.kind!=='ui')throw denied();
        const {metadata,bytes}=await parseUpload(req,url);trace.input(metadata);
        const reply=await service.import(auth,metadata,bytes),status=reply.body.operation.status;
        return send(res,['queued','running'].includes(status)?202:!reply.duplicate&&reply.body.result&&['complete','partial','unsupported'].includes(reply.body.result.outcome)?201:200,reply.body,['queued','running'].includes(status)?{'Retry-After':'2'}:{});
      }
      if(path==='/api/v1/ui_verify_artifact'){
        if(auth.kind!=='ui'||!/^multipart\/form-data\s*;/i.test(req.headers['content-type']??''))throw denied();
        const bytes=await collect(req,67*MiB),form=await new Request(url,{method:'POST',headers:{'Content-Type':req.headers['content-type']},body:bytes}).formData();
        if([...form.keys()].sort().join(',')!=='metadata,source')throw denied();
        const input=JSON.parse(form.get('metadata')),source=form.get('source');
        if(Object.keys(input).sort().join(',')!=='artifactId,protocolVersion,resultId,scope'||input.protocolVersion!==PROTOCOL_VERSION||typeof input.resultId!=='string'||typeof input.artifactId!=='string'||typeof source?.arrayBuffer!=='function')throw denied();
        trace.input(input);await repository.forScope(auth,input.scope);
        return send(res,200,verifyArtifact(repository,auth,input.scope,{resultId:input.resultId,artifactId:input.artifactId,bytes:new Uint8Array(await source.arrayBuffer())}));
      }
      const input=await parseJSON(req);trace.input(input);
      const selectedResult=resultSelectionRoute(path,auth,input,repository);if(selectedResult)return send(res,200,selectedResult);
      if(path==='/api/v1/ui_launch'){
        if(!header?.startsWith('Bearer ')||!localProjects||auth.kind!=='ui'||!auth.capabilities.has('review_memory')||Object.keys(input).sort().join(',')!=='protocolVersion,scope'||input.protocolVersion!==PROTOCOL_VERSION)throw denied();
        const selected=await localProjects.launch(auth,input.scope);
        return send(res,200,await createUiPairing(selected.auth,selected.scope,localProjects.rootAuth));
      }
      if(await serveUiRoute({path,repository,auth,input,modelAdmin,chatRoutes,modelRelay},res,expressionLinks))return;

      if(path==='/api/v1/ui_review_result'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.reviewResult(auth,input).value);
      }
      if(path==='/api/v1/ui_source_metadata'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.updateSourceMetadata(auth,input).value);
      }
      if(path==='/api/v1/ui_edit_claim'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.editClaim(auth,input).value);
      }
      if(path==='/api/v1/ui_restore_claim'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.restoreClaim(auth,input).value);
      }




      if(path==='/api/v1/ui_create_task_plan'){
        if(auth.kind!=='ui')throw denied();return send(res,201,repository.createTaskPlan(auth,input).value);
      }
      const preparation=await prepareTaskRoute(path,auth,input,service);if(preparation)return send(res,200,preparation);
      if(path==='/api/v1/ui_start_plan_step'){
        if(auth.kind!=='ui')throw denied();return send(res,202,await service.startPlanStep(auth,input,execution));
      }
      if(path==='/api/v1/ui_task_routes'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.quoteTaskRoutes(auth,input,execution?.executors(auth,input.scope)??[]));
      }
      if(path==='/api/v1/ui_select_task_route'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.selectTaskRoute(auth,input,execution?.executors(auth,input.scope)??[]));
      }

      if(path==='/api/v1/ui_resolve_conflict'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.resolveConflict(auth,input));
      }
      if(path==='/api/v1/ui_answer_question'){
        if(auth.kind!=='ui'||!execution)throw denied();return send(res,200,await execution.answer(auth,input));
      }
      if(path==='/api/v1/ui_result_lesson'){
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.proposeResultLesson(auth,input).value);
      }
      if(['authorize_execution','execute_task','execution_state','cancel_execution','reconcile_execution'].includes(path.slice('/api/v1/'.length))){
        if(auth.kind!=='ui')throw denied();
        if(!execution)throw wireFail('capability_unavailable','还没有连接执行工具。','工作说明已保留，可先交给当前工具执行。','after_input');
        const action=path.slice('/api/v1/'.length);
        if(action==='authorize_execution')return send(res,200,repository.issueExecutionAuthorization(auth,input));
        if(action==='execute_task')return send(res,202,await execution.start(auth,input));
        if(Object.keys(input).sort().join(',')!=='operationId,protocolVersion,scope'||input.protocolVersion!==PROTOCOL_VERSION||typeof input.operationId!=='string')throw denied();
        await repository.forScope(auth,input.scope);
        if(action==='cancel_execution')return send(res,200,await execution.cancel(auth,input.scope,input.operationId));
        if(action==='reconcile_execution')return send(res,200,await execution.reconcile(auth,input.scope,input.operationId));
        return send(res,200,repository.executionState(auth,input.scope,input.operationId));
      }
      if(path==='/api/v1/ui_extension'){
        if(!projectManager||!uiSession||header||auth.kind!=='ui'||Object.keys(input).sort().join(',')!=='host,protocolVersion,scope'||input.protocolVersion!==PROTOCOL_VERSION||!['codex','dsh'].includes(input.host))throw denied();
        await repository.forScope(auth,input.scope);
        const connection=await projectManager.connection(uiSession.rootAuth,input.scope,input.host),bytes=await buildDistribution(input.host,connection);
        res.writeHead(200,{'Content-Type':'application/gzip','Content-Disposition':`attachment; filename="synplex-${input.host}-workspace.tgz"`,
          'Content-Length':bytes.length,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(bytes);return;
      }
      if(['ui_create_project','ui_select_project'].includes(path.slice('/api/v1/'.length))){
        if(!projectManager||!uiSession||header||auth.kind!=='ui'||input.protocolVersion!==PROTOCOL_VERSION)throw denied();
        const creating=path.endsWith('ui_create_project');
        if(Object.keys(input).sort().join(',')!==(creating?'name,protocolVersion,requestId,scope':'protocolVersion,scope'))throw denied();
        if(creating)await projectManager.select(uiSession.rootAuth,input.scope);
        const chosen=creating?await projectManager.create(uiSession.rootAuth,input):await projectManager.select(uiSession.rootAuth,input.scope);
        accounts?.selectSession(uiSession,chosen.scope);uiSession.auth=chosen.auth;uiSession.scope=chosen.scope;
        return send(res,200,{scope:chosen.scope,state:await (await repository.forScope(chosen.auth,chosen.scope)).getState(),projects:await projectManager.list(uiSession.rootAuth)});
      }
      if(path==='/api/v1/ui_find_evidence'){
        if(auth.kind!=='ui'||Object.keys(input).sort().join(',')!=='cursor,includeHistory,limit,protocolVersion,query,scope'||input.protocolVersion!==PROTOCOL_VERSION||input.cursor!==null&&(typeof input.cursor!=='string'||input.cursor.length>4096))throw denied();
        return send(res,200,repository.query(auth,input.scope,{query:input.query,limit:input.limit,cursor:input.cursor,includeHistory:input.includeHistory,occurrenceIds:null}));
      }
      if(path==='/api/v1/ui_task_detail'){
        if(auth.kind!=='ui'||Object.keys(input).sort().join(',')!=='protocolVersion,runId,scope'||input.protocolVersion!==PROTOCOL_VERSION||typeof input.runId!=='string')throw denied();
        const run=repository.read(auth,input.scope,'run',input.runId),packet=run&&repository.read(auth,input.scope,'context',run.contextPacketId);
        if(!packet)throw denied();return send(res,200,{run,packet,conversation:repository.taskConversation(auth,input.scope,run.id)});
      }
      if(path==='/api/v1/ui_history'){
        if(auth.kind!=='ui'||Object.keys(input).sort().join(',')!=='protocolVersion,scope'||input.protocolVersion!==PROTOCOL_VERSION)throw denied();
        const repo=await repository.forScope(auth,input.scope),state=await repo.getState();
        // Bounded UI projection, never an execution or mutation endpoint.
        const claims=repository.recent(auth,input.scope,'claim');
        const sources=repository.recent(auth,input.scope,'source');
        const events=repository.recent(auth,input.scope,'occurrence');
        const runs=repository.recent(auth,input.scope,'run',100),results=repository.recent(auth,input.scope,'result',100);
        const totals={claims:repository.recordCount(auth,input.scope,'claim'),events:repository.recordCount(auth,input.scope,'occurrence')};
        const artifactFiles=repository.recent(auth,input.scope,'artifact_file');
        const sourceCoverage=repository.sourceCoverage(auth,input.scope,sources.map(s=>s.id));
        const executions=repository.recent(auth,input.scope,'execution_job',100).map(job=>repository.executionState(auth,input.scope,job.id));
        const latest=runs.at(-1),latestWork=latest?{run:latest,packet:repository.read(auth,input.scope,'context',latest.contextPacketId),conversation:repository.taskConversation(auth,input.scope,latest.id)}:null;
        const resultReviews=repository.list(auth,input.scope,'result_review');
        const resultRequirements=Object.fromEntries(results.map(result=>{const attempt=repository.read(auth,input.scope,'attempt',result.attemptId),run=attempt&&repository.read(auth,input.scope,'run',attempt.runId),packet=run&&repository.read(auth,input.scope,'context',run.contextPacketId);return [result.id,packet?{runId:run.id,goal:packet.goal,acceptanceCriteria:packet.acceptanceCriteria}:null];}));
        const conflicts=repository.conflictDetails(auth,input.scope);
        const usage=repository.usageLedger(auth,input.scope),budget=repository.budgetStatus(auth,input.scope);
        const taskPlans=repository.recent(auth,input.scope,'task_plan',30).map(p=>repository.taskPlan(auth,input.scope,p.id));
        const modelCalls=Object.fromEntries(executions.map(x=>[x.operation.id,modelRelay?.calls(auth,input.scope,x.operation.id)??[]]));
        const taskSteps=repository.recent(auth,input.scope,'task_step',100);
        const sourceMetadata=sources.map(s=>repository.sourceMetadata(auth,input.scope,s.id));
        return send(res,200,{state,claims,sources,sourceCoverage,events,runs,results,totals,modelCalls,artifactFiles,resultReviews,resultRequirements,executions,latestWork,conflicts,usage,budget,taskPlans,taskSteps,sourceMetadata,sourcePreviewPages:true,materialQuestions:true,taskFollowups:true,taskResultAdoption:true,claimVersionActions:true,materialBriefs:true,recordJourney:true,resultVersionActions:true,artifactPreviews:true,noteExports:true,projectExpressions:true,projectExpressionVersions:true,executionStatus:repository.executionStatus(auth,input.scope),diagnostics:diagnosticStatus(diagnostics)});
      }
      if(path==='/api/v1/ui_reconcile_usage'){
        if(auth.kind!=='ui')throw denied();
        const result=repository.reconcileUsage(auth,input);return send(res,200,result.value);
      }
      if(path==='/api/v1/ui_reconnect_input'){
        if(auth.kind!=='ui'||!execution)throw denied();return send(res,200,await execution.reconnectInput(auth,input));
      }




      if(path==='/api/v1/get_import_result') {
        validateWire('GetImportResultRequest',input);const repo=await repository.forScope(auth,input.scope);const body=await repo.getImportResult(input.operationId);
        const pending=['queued','running'].includes(body.operation.status);return send(res,pending?202:200,body,pending?{'Retry-After':'2'}:{});
      }
      if(path==='/api/v1/authorize_review') {
        if(auth.kind!=='ui'||Object.hasOwn(input,'authorizationId'))throw denied();
        return send(res,200,repository.issueReviewAuthorization(auth,input));
      }
      if(path==='/api/v1/review_claim') {
        if(auth.kind!=='ui')throw denied();return send(res,200,repository.review(auth,input));
      }
      return send(res,200,await service.call(auth,path.slice('/api/v1/'.length),input));
    }catch(error){
      trace.failure(error);
      const safe=error.uiPairing?{code:'scope_denied',message:'连接码已过期、已使用或不正确。',nextAction:'请刷新本机入口，使用新连接码；已保存的工作不会重跑。',retry:'after_input',operationId:null}:safeError(error),status=error.httpStatus??statusFor(safe);
      // Consume/discard remaining bytes without buffering. Destroying the socket while the
      // caller is still uploading turns a useful 413 into EPIPE and hides the next action.
      if(status===413)req.resume();
      send(res,status,safe);
    }
  });
  server.on('close',()=>expressionLinks.clear());
  server.requestTimeout=30_000;server.headersTimeout=10_000;server.keepAliveTimeout=5000;
  return {server,service,capabilities:capabilityInfo,createUiPairing,listen:async(port=0)=>{
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve();});});
    return `http://127.0.0.1:${server.address().port}`;
  },close:async()=>{await chatRoutes.close();await modelRelay?.close();await execution?.close();await service.idle();if(server.listening)await new Promise((resolve,reject)=>server.close(e=>e?reject(e):resolve()));}};
}
