import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {payloadHash,validateWire} from '../../packages/contracts/validate.mjs';
const dir=mkdtempSync(join(tmpdir(),'synplex-memory-capacity-')),repository=new WorkspaceRepository({dataDir:dir});
const scope={projectId:'memory-capacity',versionId:null,branchId:null},credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory']}),auth=repository.authenticate(credential.token);
try{
 const db=new DatabaseSync(join(dir,'workspace.sqlite')),partition=db.prepare('SELECT partition FROM scopes').get().partition,statement=db.prepare("INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,'claim',?,?,?)"),stamp='2026-10-15T00:00:00.000Z';
 db.exec('BEGIN IMMEDIATE');for(let i=0;i<5000;i++){
  const active=i>=4980,claim=validateWire('Claim',{id:'capacity-'+i,type:'unknown',title:'待核对信息',body:'历史材料需要保留，不能作为当前结论。'+ '原始上下文。'.repeat(700),evidenceKind:'user_statement',evidence:[],supersedes:[],condition:null,occurredAt:null,lifecycle:active?'active':'superseded',reviewStatus:active?'pending':'rejected',recordedAt:stamp,effectiveFrom:null,effectiveUntil:active?null:stamp,actorId:'human'});
  statement.run(partition,claim.id,payloadHash(claim),JSON.stringify(claim));
 }db.exec('COMMIT');db.close();
 const prior=()=>{const all=repository.list(auth,scope,'claim');return {pending:all.filter(c=>c.lifecycle==='active'&&c.reviewStatus==='pending'),unknowns:all.filter(c=>c.type==='unknown'&&c.lifecycle==='active'&&c.reviewStatus!=='rejected').map(c=>c.body)};};
 const samples=[];for(let i=0;i<3;i++){const before=performance.now(),old=prior(),priorMs=performance.now()-before,start=performance.now(),current=repository.state(auth,scope),currentMs=performance.now()-start;assert.deepEqual(current.pending,old.pending);assert.deepEqual(current.unknowns,old.unknowns);samples.push({priorMs,currentMs});}
 const result={measuredAt:new Date().toISOString(),node:process.version,platform:process.platform,records:5000,currentRecords:20,historicalRecords:4980,bodyCharactersPerRecord:('历史材料需要保留，不能作为当前结论。'+ '原始上下文。'.repeat(700)).length,samples,modelCalls:0,limits:'Three paired algorithm measurements on synthetic historical claims; not production p95, whole-product latency, semantic quality or paid efficacy. All current records are retained, including necessary boundaries; large active sets may still exceed a context budget.'};
 writeFileSync('.runtime/implementation-baseline/memory-state-capacity.json',JSON.stringify(result,null,2));process.stdout.write(JSON.stringify(result)+'\n');
}finally{repository.close();rmSync(dir,{recursive:true,force:true});}
