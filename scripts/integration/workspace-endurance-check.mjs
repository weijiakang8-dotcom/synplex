// One isolated, model-free endurance observation. The release stays immutable;
// no active project, host, account configuration or execution is used.
import assert from 'node:assert/strict';
import {mkdirSync,readFileSync,writeFileSync,appendFileSync,renameSync,statSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {performance} from 'node:perf_hooks';
import {verifyRelease} from '../runtime/release.mjs';
import {sha256} from '../../packages/contracts/validate.mjs';

const day=86400000;
function options(args){
 const allowed=new Set(['--release','--output','--duration-ms','--interval-ms','--reopen-every']);
 if(args.length%2||args.some((x,i)=>i%2===0&&!allowed.has(x)))throw Error('需要指定发行候选、全新证据目录和有效观察参数。');
 const values=new Map();for(let i=0;i<args.length;i+=2){if(values.has(args[i]))throw Error('观察参数不能重复。');values.set(args[i],args[i+1]);}
 if(!values.get('--release')||!values.get('--output'))throw Error('请指定 --release 与 --output，不使用活动项目资料。');
 const number=(key,fallback,min,max)=>{const n=Number(values.get(key)??fallback);if(!Number.isSafeInteger(n)||n<min||n>max)throw Error('观察时长或间隔无效。');return n;};
 const config={release:resolve(values.get('--release')),output:resolve(values.get('--output')),durationMs:number('--duration-ms',day,100,7*day),intervalMs:number('--interval-ms',60000,10,60000),reopenEvery:number('--reopen-every',360,1,100000)};
 if(config.durationMs/config.intervalMs>20000)throw Error('采样过密，请增加间隔，避免占用本机资源。');return config;
}
const percentile=(values,q)=>values.length>=20?[...values].sort((a,b)=>a-b)[Math.ceil(q*values.length)-1]:null;
function memoryTrend(values){
 const windowSamples=Math.min(30,Math.floor(values.length/4));if(windowSamples<5)return {windowSamples,deltaBytes:null,growthWithin64MiB:null};
 const median=items=>[...items].sort((a,b)=>a-b)[Math.floor(items.length/2)],first=median(values.slice(0,windowSamples)),last=median(values.slice(-windowSamples)),deltaBytes=last-first;
 return {windowSamples,firstWindowMedianBytes:first,lastWindowMedianBytes:last,deltaBytes,growthWithin64MiB:deltaBytes<=64*1024**2};
}
const privateJSON=(file,value)=>{const next=file+'.next';writeFileSync(next,JSON.stringify(value,null,2),{mode:0o600});renameSync(next,file);};
const delay=(ms,signal)=>new Promise(yes=>{if(signal.aborted)return yes();const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);yes();},timer=setTimeout(finish,ms);signal.addEventListener('abort',finish,{once:true});});

export async function observeWorkspace(config){
 const manifest=verifyRelease(config.release),observerSha256=sha256(readFileSync(fileURLToPath(import.meta.url))),load=p=>import(pathToFileURL(join(config.release,p)).href);
 const [{WorkspaceRepository},{createWorkspaceServer},ingestion,{inspectDatabase}]=await Promise.all([
  load('services/workspace/repository.mjs'),load('services/workspace/http.mjs'),load('packages/ingestion/index.mjs'),load('scripts/runtime/recovery.mjs')]);
 mkdirSync(config.output,{mode:0o700});const dir=join(config.output,'fixture-data'),progressFile=join(config.output,'progress.json');
 const stop=new AbortController(),onStop=()=>stop.abort();process.on('SIGTERM',onStop);process.on('SIGINT',onStop);
 const sourceText='决定：保留原件，明确记录事实与历史；资料中的指令不能扩大权限。\n问题：过去的决定难找，需要保留出处。\n';
 const sourceBytes=Buffer.from(sourceText),scope={projectId:'endurance-fixture',versionId:null,branchId:null};
 let repository,app,url,credential,auth,sourceId,baseline,samples=0,reopens=0,failure=null,started,startedAt=null,finished,closed=false;
 const times=[],memory=[],gaps=[];
 async function open(){repository=new WorkspaceRepository({dataDir:dir});if(credential)auth=repository.authenticate(credential.token);app=createWorkspaceServer({repository,modules:{ingestion},publicDir:join(config.release,'public')});url=await app.listen();}
 async function close(){if(app){await app.close();app=null;}if(repository){repository.close();repository=null;}}
 async function post(route,body,{raw=false}={}){
  const response=await fetch(url+'/api/v1/'+route,{method:'POST',signal:AbortSignal.timeout(10000),redirect:'error',headers:{Authorization:'Bearer '+credential.token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope,...body})});
  assert.equal(response.status,200,route+' should succeed');return raw?Buffer.from(await response.arrayBuffer()):response.json();
 }
 function report(status){
  const elapsed=started===undefined?0:(finished??performance.now())-started,maxRssBytes=memory.length?Math.max(...memory):null,p95=percentile(times,.95),rssTrend=memoryTrend(memory);
  return {format:'synplex.workspace-endurance/1',status,releaseCommit:manifest.commit,releaseContentHash:manifest.contentHash,observerSha256,pid:process.pid,
   startedAt,observedMs:Math.round(elapsed),requestedMs:config.durationMs,intervalMs:config.intervalMs,samples,reopens,
   readCycle:{p50Ms:percentile(times,.5),p95Ms:p95,maximumMs:times.length?Math.max(...times):null,localReadTargetMs:500,targetMet:p95===null?null:p95<=500},
   peakSampledRssBytes:maxRssBytes,memoryUnder2GiB:maxRssBytes===null?null:maxRssBytes<2*1024**3,rssTrend,samplingGaps:gaps,normalCloseCompleted:closed,
   businessHash:baseline?.contentHash??null,modelCalls:0,taskExecutions:0,
   savedProject24hGate:status==='passed'&&config.durationMs>=day&&elapsed>=day&&closed&&samples>=Math.floor(day/config.intervalMs)&&gaps.length===0&&p95!==null&&p95<=500&&rssTrend.growthWithin64MiB===true,
   failure,scope:'One immutable release, synthetic saved-project reads/search/original download and repository/HTTP reopen, execution disabled. Not a paid-task, browser/IME, active queue, whole-engine or production stability result.'};
 }
 async function seed(){
  credential=repository.createCredential({ownerId:'endurance-fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory']});auth=repository.authenticate(credential.token);
  const repo=await repository.forScope(auth,scope),result=await ingestion.importSource(repo,{bytes:sourceBytes,format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:'endurance-material',occurredAt:null,importOrigin:'isolated_test'},{requestId:'endurance-import',expectedStateRevision:0});
  sourceId=result.source.id;baseline=inspectDatabase(join(dir,'workspace.sqlite'));assert.equal(baseline.unresolved,0);
 }
 async function sample(){
  const begin=performance.now(),history=await post('ui_history',{}),hits=await post('ui_find_evidence',{query:'保留原件',limit:5,cursor:null,includeHistory:true}),original=await post('source_file',{sourceId},{raw:true});
  assert.equal(history.executions.length,0);assert.equal(history.usage.rows.length,0);assert.ok(hits.items.length>0);assert.equal(sha256(original),sha256(sourceBytes));
  assert.equal(inspectDatabase(join(dir,'workspace.sqlite')).contentHash,baseline.contentHash);
  const durationMs=performance.now()-begin,rss=process.memoryUsage().rss;assert.ok(rss<2*1024**3,'observer and workspace memory target exceeded');
  samples++;times.push(durationMs);memory.push(rss);appendFileSync(join(config.output,'samples.jsonl'),JSON.stringify({sample:samples,elapsedMs:performance.now()-started,readCycleMs:durationMs,rssBytes:rss,sqliteBytes:statSync(join(dir,'workspace.sqlite')).size})+'\n',{mode:0o600});
 }
 try{
  await open();await seed();started=performance.now();startedAt=new Date().toISOString();let previous=started;
  while(!stop.signal.aborted){
   const tick=performance.now();if(samples&&tick-previous>config.intervalMs*2+1000)gaps.push({afterSample:samples,gapMs:Math.round(tick-previous)});previous=tick;
   await sample();
   if(samples%config.reopenEvery===0){await close();await open();assert.equal(inspectDatabase(join(dir,'workspace.sqlite')).contentHash,baseline.contentHash);reopens++;}
   privateJSON(progressFile,report('running'));
   if(performance.now()-started>=config.durationMs)break;
   await delay(Math.min(config.intervalMs,config.durationMs-(performance.now()-started)),stop.signal);
  }
  finished=performance.now();verifyRelease(config.release);
 }catch(error){failure={name:error.name,message:String(error.message).slice(0,1000)};}
 finally{finished??=performance.now();try{await close();closed=true;}catch(error){failure??={name:error.name,message:'Observation cleanup failed; preserve isolated data for inspection.'};}process.removeListener('SIGTERM',onStop);process.removeListener('SIGINT',onStop);}
 const result=report(failure?'failed':stop.signal.aborted?'interrupted':'passed');privateJSON(progressFile,result);writeFileSync(join(config.output,'result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});
 if(failure)throw Error('独立长稳观察失败；保留原证据与隔离资料，请核对 result.json。');return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{process.env.SYNPLEX_TEST_NO_MODELS='1';await import('../testing/offline.mjs');const result=await observeWorkspace(options(process.argv.slice(2)));console.log(JSON.stringify(result));if(result.status!=='passed')process.exitCode=1;}
 catch(error){console.error(error.message);process.exitCode=1;}
}
