// The original directories are retained as the local authority witnesses.
// A copied enabled flag, missing witness or unfinished transfer cannot run.
import {lstatSync,readFileSync,realpathSync} from 'node:fs';
import {join,dirname,isAbsolute} from 'node:path';
import {payloadHash} from '../../packages/contracts/validate.mjs';

export const HANDOFF_PROTOCOL='synplex.idle-product-handoff/1';
export const HANDOFF_RETIRED='handoff-retired.json';
export const HANDOFF_PENDING='handoff-pending.json';
export const HANDOFF_COMPLETE='handoff-complete.json';
const fail=()=>{throw Error('恢复接续尚未完整核对，请保留原资料和恢复目录，不要重新执行任务。');};
const present=file=>{try{lstatSync(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}};
export function readHandoffJSON(file){
 const stat=lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077)fail();
 return JSON.parse(readFileSync(file,'utf8'));
}
function directory(path){
 if(typeof path!=='string'||!isAbsolute(path))fail();
 const stat=lstatSync(path);
 if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077||realpathSync(path)!==path)fail();
 return path;
}
export function validateHandoffProof(proof){
 if(!proof||Object.keys(proof).sort().join(',')!=='format,id,snapshot,snapshotSha256,source,target'||proof.format!==HANDOFF_PROTOCOL||!/^[a-f0-9-]{36}$/.test(proof.id??'')||!/^[a-f0-9]{64}$/.test(proof.snapshotSha256??''))fail();
 const roots=[];
 for(const part of [proof.source,proof.target]){
  if(!part||Object.keys(part).sort().join(',')!=='engine,engineId,infrastructureId,workspace')fail();
  roots.push(directory(part.workspace),directory(part.engine));
  if(![part.engineId,part.infrastructureId].every(x=>typeof x==='string'&&x.length>0))fail();
 }
 for(const [index,path] of roots.entries())if(roots.slice(index+1).some(other=>other===path||other.startsWith(path+'/')||path.startsWith(other+'/')))fail();
 if(dirname(proof.target.workspace)!==dirname(proof.target.engine)||proof.target.engineId!==proof.source.engineId)fail();
 return proof;
}
export function validateWorkspaceHandoff(dataDir,proof,{complete=true}={}){
 validateHandoffProof(proof);if(directory(dataDir)!==proof.target.workspace)fail();
 for(const part of [proof.source.workspace,proof.source.engine])if(payloadHash(readHandoffJSON(join(part,HANDOFF_RETIRED)))!==payloadHash(proof))fail();
 if(complete&&payloadHash(readHandoffJSON(join(dirname(dataDir),HANDOFF_COMPLETE)))!==payloadHash(proof))fail();
 const saved=readHandoffJSON(join(proof.target.engine,'engine-startup.json')),bootstrap=readHandoffJSON(join(proof.target.engine,'engine/bootstrap.json'));
 if(saved.infrastructureId!==proof.target.infrastructureId||bootstrap.id!==proof.target.engineId)fail();
 return proof;
}
export function assertWorkspaceAdmission(dataDir){
 const migration=join(dirname(dataDir),'materials-migration.json');
 if(present(migration)){
  const record=readHandoffJSON(migration);
  if(record.status!=='complete'||typeof record.bootstrap!=='string'||!record.bootstrap.startsWith(dataDir+'.before-materials-')||typeof record.fingerprint!=='string'||!/^[a-f0-9]{64}$/.test(record.fingerprint))fail();
  directory(record.bootstrap);
  const audit=readHandoffJSON(join(dataDir,'materials-recovery.json'));
  if(audit.executorsEnabled!==false||audit.materialsOnlyMigration!==migration||audit.snapshot!==record.snapshot)fail();
 }
 if(present(join(dataDir,HANDOFF_RETIRED)))throw Error('这份原工作台已停止使用，请打开核对后的恢复副本；原资料仍保留。');
 const pending=join(dataDir,HANDOFF_PENDING),recovery=join(dataDir,'recovery.json');
 if(present(pending))validateWorkspaceHandoff(dataDir,readHandoffJSON(pending));
 if(!present(recovery))return;
 const record=readHandoffJSON(recovery);
 if(record.executorsEnabled!==true)return; // A disabled restore can still be read.
 const proof=validateWorkspaceHandoff(dataDir,record.handoff),engine=readHandoffJSON(join(proof.target.engine,'recovery.json'));
 if(engine.executorsEnabled!==true||payloadHash(engine.handoff)!==payloadHash(proof))fail();
}
