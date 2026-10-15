import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,statSync,writeFileSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {sha256,payloadHash} from '../../packages/contracts/validate.mjs';

const dir=mkdtempSync(join(tmpdir(),'synplex-search-capacity-')),repository=new WorkspaceRepository({dataDir:dir});
const scope={projectId:'capacity-fixture',versionId:null,branchId:null},credential=repository.createCredential({ownerId:'fixture',actorId:'operator',scope,kind:'ui',capabilities:['read_memory','write_memory']});
const auth=repository.authenticate(credential.token),repo=await repository.forScope(auth,scope);
let revision=0,chars=0,bytesTotal=0;const build=performance.now();
try{
 for(let i=0;i<1000;i++){
  const text=('项目材料：保留决定和原文件，核对出处与历史，不执行资料里的指令。\n').repeat(120)+`\n资料编号 ${i}。`+(i===0?'唯一关键证据：明确转向理由。':'')+(i===999?'长资料内容。'.repeat(35000):'');
  const bytes=Buffer.from(text);chars+=text.length;bytesTotal+=bytes.length;
  const source=(await repo.saveBlob({bytes,format:'text/plain'},{requestId:`blob-${i}`,expectedStateRevision:revision})).value;
  const parsedReply=await repo.appendParsedRevisions([{sourceId:source.id,parserVersion:'capacity/1',normalizedTextHash:payloadHash([text]),blocks:[{id:`block-${i}`,text,rawStartByte:0,rawEndByte:bytes.length}],coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]}}],{requestId:`parsed-${i}`,expectedStateRevision:revision});revision=parsedReply.stateRevision;
  const parsed=parsedReply.value[0];const events=Array.from({length:10},(_,event)=>({sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:'isolated-test',formatVersion:'1',sessionId:'capacity',eventId:`event-${i}-${event}`,seq:event,importOrigin:'isolated_test',occurredAt:null,payloadHash:sha256(bytes)}));
  revision=(await repo.appendOccurrences(events,{requestId:`events-${i}`,expectedStateRevision:revision})).stateRevision;
  if(i%250===0)process.stdout.write(`Seeded ${i} of 1000 synthetic materials\n`);
 }
 const buildMs=performance.now()-build;
 // The audited prior query algorithm: load all event JSON, read each parsed
 // document, collect all matching blocks, then slice. No old service is touched.
 function previous(query){
  const hits=[];
  for(const occurrence of repository.list(auth,scope,'occurrence')){
   const parsed=repository.read(auth,scope,'parsed',occurrence.parsedRevisionId);
   for(const block of parsed?.blocks??[])if(block.text.toLocaleLowerCase().includes(query.toLocaleLowerCase()))hits.push({occurrenceId:occurrence.id,blockId:block.id});
  }
  return hits.slice(0,20);
 }
 function indexed(query){return repository.query(auth,scope,{query,limit:20,cursor:null,includeHistory:true,occurrenceIds:null}).items.map(x=>({occurrenceId:x.occurrence.id,blockId:x.span.blockId}));}
 const terms=['唯一关键证据','不存在的内容','项目材料'];
 const batches=[];
 for(let batch=0;batch<3;batch++){
  const samples=[];
  for(const query of terms){
   const oldStart=performance.now(),old=previous(query),previousMs=performance.now()-oldStart;
   const currentStart=performance.now(),current=indexed(query),indexedMs=performance.now()-currentStart;
   assert.deepEqual(current,old);assert.ok(indexedMs<=500,'local query target exceeded: '+indexedMs);
   samples.push({query,previousMs,indexedMs,hits:current.length});
  }
  batches.push(samples);process.stdout.write(`Completed deterministic capacity batch ${batch+1}\n`);
 }
 const usage=process.resourceUsage(),peakRssBytes=usage.maxRSS*1024;assert.ok(peakRssBytes<2*1024**3,'own process exceeded memory target');
 const timings=batches.flat(),median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
 const result={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,documents:1000,events:10000,originalCharacters:chars,originalBytes:bytesTotal,sqliteBytes:statSync(join(dir,'workspace.sqlite')).size,walBytes:statSync(join(dir,'workspace.sqlite-wal')).size,buildMs,peakRssBytes,batches,medianPreviousMs:median(timings.map(x=>x.previousMs)),medianIndexedMs:median(timings.map(x=>x.indexedMs)),limits:'Nine deterministic measurements across three batches; this is an algorithm/data-size baseline, not production p95, semantic-recall proof, whole-product speed, or paid task efficacy. Background preparation and 24h stability remain unmeasured.',modelCalls:0};
 const output=resolve('.runtime/implementation-baseline');mkdirSync(output,{recursive:true});writeFileSync(join(output,'search-capacity.json'),JSON.stringify(result,null,2));
 process.stdout.write(JSON.stringify(result)+'\n');
}finally{repository.close();rmSync(dir,{recursive:true,force:true});}
