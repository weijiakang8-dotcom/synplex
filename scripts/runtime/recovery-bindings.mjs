// Offline inspection only. Never loads an executor, rewrites a binding or sends HTTP.
import {existsSync,lstatSync,readFileSync,realpathSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import {inspectDatabase,verifySnapshot} from './recovery.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {validateWorkspaceHandoff} from './handoff-state.mjs';

const read=file=>{
 const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.uid!==process.getuid()||s.mode&0o077)throw Error('核对资料必须仅本人可读，且不能使用替身。');
 return JSON.parse(readFileSync(file,'utf8'));
};
function originalTarget(snapshot,engineSource,bootstrap){
 const c=read(join(snapshot,'executors.json')).synplex;
 if(!c||c.workflowId!==bootstrap.workflow_id||c.tokenFile!==join(engineSource,'engine/access-token'))throw Error('原工作台连接不属于这份引擎快照，未映射任何任务。');
 const u=new URL(c.endpoint);
 if(u.origin!==`http://127.0.0.1:${bootstrap.api_port}`||u.pathname!=='/'||u.search||u.hash||u.username||u.password)throw Error('原工作台的连接地址与引擎来源不一致。');
 return payloadHash({endpoint:u.origin,workflowId:c.workflowId,tokenFile:c.tokenFile});
}
function unidentifiedBinding(base,binding){
 if(!/^[a-f0-9]{64}$/.test(binding.payloadHash??''))return {...base,state:'unidentified_submission'};
 return {...base,state:'ready_to_find_original',packetHash:binding.packetHash,payloadHash:binding.payloadHash};
}
function inspectBinding(db,row,targetKey,restored){
 const body=JSON.parse(row.body_json),base={operationId:row.id,attemptId:body.attemptId,taskId:body.taskId};
 if(body.binding?.targetKey!==targetKey)return {...base,state:'other_connection'};
 const get=(kind,id)=>{const r=db.prepare('SELECT body_json FROM records WHERE partition=? AND kind=? AND id=?').get(row.partition,kind,id);return r?JSON.parse(r.body_json):null;};
 const job=get('execution_job',row.id),packet=job&&get('context',job.packetId);
 if(body.id!==row.id||job?.attemptId!==body.attemptId||!packet||packet.contentHash!==body.binding.packetHash)return {...base,state:'binding_mismatch'};
 const {contentHash,...content}=packet;if(payloadHash(content)!==contentHash)return {...base,state:'binding_mismatch'};
 const journal=join(restored,'executors/agenthub',row.id+'.json');
 if(!/^[a-f0-9-]{36}$/i.test(row.id))return {...base,state:'binding_mismatch'};
 if(existsSync(journal)){
  const saved=read(journal);
  if(saved.operationId!==row.id||saved.attemptId!==body.attemptId||saved.taskId!==body.taskId||saved.targetKey!==targetKey)return {...base,state:'journal_mismatch'};
 }
 if(body.taskId===null)return unidentifiedBinding(base,body.binding);
 if(typeof body.taskId!=='string'||!/^[a-f0-9-]{36}$/i.test(body.taskId))return {...base,state:'binding_mismatch'};
 return {...base,state:'ready_to_inspect'};
}
export function inspectRestoredBindings(snapshot,restored,engineSource,bootstrapFile,{handoff=null}={}){
 snapshot=realpathSync(snapshot);restored=realpathSync(restored);engineSource=resolve(engineSource);
 const manifest=verifySnapshot(snapshot),state=inspectDatabase(join(restored,'workspace.sqlite'));
 if(payloadHash(manifest.data)!==payloadHash(state))throw Error('恢复后的工作台数据已有变化，不能把快照当成当前任务证明。');
 const recovery=read(join(restored,'recovery.json'));
 if(handoff)validateWorkspaceHandoff(restored,handoff,{complete:false});
 const ordinary=recovery.executorsEnabled===false&&!existsSync(join(restored,'executors.json'));
 const transferring=handoff&&(recovery.executorsEnabled===false||recovery.executorsEnabled===true&&payloadHash(recovery.handoff)===payloadHash(handoff));
 if(recovery.format!=='synplex.safe-restoration/1'||resolve(recovery.snapshot)!==snapshot||!ordinary&&!transferring)throw Error('仅核对尚未启用的原快照恢复目录。');
 const original=read(join(snapshot,'executors.json')),copied=read(join(restored,'executors.before-recovery.json'));
 if(payloadHash(original)!==payloadHash(copied))throw Error('恢复前后的原执行设置不同，未映射任何任务。');
 const targetKey=originalTarget(snapshot,engineSource,read(bootstrapFile));
 const db=new DatabaseSync(join(restored,'workspace.sqlite'),{readOnly:true});
 try{
  const rows=db.prepare("SELECT partition,id,body_json FROM records WHERE kind='remote_submission' ORDER BY partition,id").all();
  const bindings=rows.map(row=>inspectBinding(db,row,targetKey,restored)),seen=new Map();
  for(const b of bindings)if(b.state==='ready_to_inspect'){
   if(seen.has(b.taskId)){b.state='duplicate_remote_identity';seen.get(b.taskId).state='duplicate_remote_identity';}else seen.set(b.taskId,b);
  }
  return {format:'synplex.recovery-bindings/1',workspaceFingerprint:state.contentHash,bindings,executorsEnabled:false,bindingsChanged:false};
 }finally{db.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const [snapshot,restored,engineSource,bootstrapFile,flag,intent]=process.argv.slice(2);
  if(flag&&flag!=='--handoff-intent')throw Error();
  console.log(JSON.stringify(inspectRestoredBindings(snapshot,restored,engineSource,bootstrapFile,{handoff:flag?read(intent).proof:null})));
 }
 catch{console.error('原任务身份未能核对；执行工具保持停用，原资料未修改。');process.exitCode=1;}
}
