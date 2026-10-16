// Operator-only additive transfer. No HTTP route, credentials or task execution.
import{DatabaseSync}from'node:sqlite';
import{readFileSync,writeFileSync,mkdirSync,existsSync,renameSync}from'node:fs';
import{join,resolve}from'node:path';
import{fileURLToPath}from'node:url';
import{randomUUID,createHash}from'node:crypto';
import{payloadHash}from'../../packages/contracts/hash.mjs';
import{WorkspaceRepository}from'../../services/workspace/repository.mjs';
import{acquireWorkspaceLease}from'./workspace-lease.mjs';
const hash=b=>createHash('sha256').update(b).digest('hex');
const identity=email=>String(email).trim().toLowerCase();
function idle(db,{archiveIncompleteChats=false}={}){
 const queries=["SELECT 1 FROM records WHERE kind='operation' AND json_extract(body_json,'$.status') IN ('queued','running','unknown') LIMIT 1",archiveIncompleteChats?"SELECT 1 FROM chat_requests WHERE status IN ('queued','running') OR status='unknown' AND json_extract(body_json,'$.finishedAt') IS NULL LIMIT 1":"SELECT 1 FROM chat_requests WHERE status IN ('queued','running','unknown') LIMIT 1","SELECT 1 FROM model_execution_calls WHERE status IN ('running','unknown') LIMIT 1"];
 for(const q of queries)if(db.prepare(q).get())throw Error('仍有执行或费用需要核对，未迁移，也不会重新执行。');
}
function rows(db,table,where='',args=[]){return db.prepare(`SELECT * FROM ${table} ${where} ORDER BY rowid`).all(...args);}
function selectedRows(db,table,column,ids){return rows(db,table,`WHERE ${column} IN (SELECT value FROM json_each(?))`,[JSON.stringify(ids)]);}
function legacyIdentity(db,directory){
 const c=JSON.parse(readFileSync(join(directory,'connection.json'),'utf8')),token=readFileSync(c.uiTokenFile,'utf8').trim();
 const credential=db.prepare("SELECT c.actor_id,s.owner_id,s.scope_json FROM credentials c JOIN scopes s ON s.partition=c.partition WHERE c.token_hash=? AND c.kind='ui' AND c.revoked=0").get(hash(token));
 if(!credential)throw Error('原私人工作台身份未通过核对。');return{id:'legacy-private',...credential};
}
export function exportHistory(directory,email,{legacy=false,archiveIncompleteChats=false}={}){
 const db=new DatabaseSync(join(directory,'workspace.sqlite'),{readOnly:true});
 try{
  db.exec('BEGIN');idle(db,{archiveIncompleteChats});
  const a=legacy?legacyIdentity(db,directory):db.prepare('SELECT id,owner_id,actor_id,scope_json FROM workspace_accounts WHERE lower(email)=? AND active=1').get(identity(email));
  if(!a)throw Error('原工作台没有这个邮箱的账号。');
  const scopes=rows(db,'scopes','WHERE owner_id=?',[a.owner_id]),partitions=scopes.map(x=>x.partition);
  const conversations=selectedRows(db,'chat_conversations','partition',partitions).filter(x=>x.actor_id===a.actor_id),requests=selectedRows(db,'chat_requests','conversation_id',conversations.map(x=>x.id));
  const records=selectedRows(db,'records','partition',partitions),operations=records.filter(x=>x.kind==='execution_job').map(x=>x.id);
  const grants=selectedRows(db,'model_execution_grants','operation_id',operations);
  if(grants.some(x=>JSON.parse(x.body_json).status==='active'))throw Error('原执行授权尚未结束，未迁移。');
  const calls=selectedRows(db,'model_execution_calls','grant_id',grants.map(x=>x.id)).map(({response,...row})=>({...row,response:response?Buffer.from(response).toString('base64'):null}));
  const blobs=rows(db,'raw_blobs','WHERE owner_id=?',[a.owner_id]).map(x=>({sha256:x.sha256,bytes:Buffer.from(x.bytes).toString('base64')}));
  const accountCatalog=join(directory,'accounts',a.id,'projects.json'),catalog=JSON.parse(readFileSync(existsSync(accountCatalog)?accountCatalog:join(directory,'projects.json'),'utf8'));
  if(catalog.binding!==payloadHash({ownerId:a.owner_id,actorId:a.actor_id,scope:JSON.parse(a.scope_json)}))throw Error('原项目目录与账号不一致。');
  const data={format:'synplex.completed-history/1',email:identity(email),originalOwner:a.owner_id,originalActor:a.actor_id,scopes,projects:catalog.entries.map(({scope,name})=>({scope,name})),records,blobs,conversations,requests,events:selectedRows(db,'chat_events','request_id',requests.map(x=>x.id)),grants,calls};
  return{...data,sha256:payloadHash(data)};
 }finally{db.close();}
}
function verifyBundle(bundle){
 const{sha256,...data}=bundle;
 if(data.format!=='synplex.completed-history/1'||payloadHash(data)!==sha256)throw Error('迁移内容指纹不一致。');
 const partitions=new Set(data.scopes.map(s=>s.partition));
 if(data.records.some(r=>!partitions.has(r.partition)||payloadHash(JSON.parse(r.body_json))!==r.payload_hash))throw Error('记录来源或内容指纹不一致。');
 for(const b of data.blobs)if(hash(Buffer.from(b.bytes,'base64'))!==b.sha256)throw Error('原件指纹不一致。');
 for(const s of data.scopes)if(s.owner_id!==data.originalOwner||s.partition!==payloadHash({ownerId:data.originalOwner,scope:JSON.parse(s.scope_json)}))throw Error('原项目归属不一致。');
 if(data.conversations.some(c=>!partitions.has(c.partition)||c.actor_id!==data.originalActor))throw Error('对话归属不一致。');
 return data;
}
function insertExact(db,table,row,keys){
 const prior=db.prepare(`SELECT * FROM ${table} WHERE ${keys.map(k=>k+'=?').join(' AND ')}`).get(...keys.map(k=>row[k]));
 if(prior){if(payloadHash({...prior,response:prior.response?Buffer.from(prior.response).toString('base64'):prior.response})!==payloadHash({...row,response:row.response?Buffer.from(row.response).toString('base64'):row.response}))throw Error('目标已有不同版本，保留原数据，停止迁移：'+table);return;}
 const columns=Object.keys(row),allowed=new Set(db.prepare('PRAGMA table_info('+table+')').all().map(c=>c.name));if(columns.some(k=>!allowed.has(k)))throw Error('迁移字段不符合数据库结构。');db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`).run(...columns.map(k=>row[k]));
}
function importRows(db,bundle,account){
 const mapping=new Map();
 for(const s of bundle.scopes){const scope=JSON.parse(s.scope_json),partition=payloadHash({ownerId:account.owner_id,scope});mapping.set(s.partition,partition);
  db.prepare('INSERT OR IGNORE INTO scopes VALUES(?,?,?,?,?)').run(partition,account.owner_id,s.scope_json,s.state_revision,0);
 }
 for(const row of bundle.records){let value={...row,partition:mapping.get(row.partition)};
  if(row.kind==='execution_job'){const body={...JSON.parse(row.body_json),archiveOrigin:{kind:'completed_history',fingerprint:bundle.sha256}};value={...value,body_json:JSON.stringify(body),payload_hash:payloadHash(body)};}
  if(row.kind==='execution_job'){const prior=db.prepare("SELECT body_json FROM records WHERE partition=? AND kind='execution_job' AND id=?").get(value.partition,value.id);if(prior){const {archiveOrigin:oldOrigin,...oldBody}=JSON.parse(prior.body_json),{archiveOrigin:newOrigin,...newBody}=JSON.parse(value.body_json);if(oldOrigin&&payloadHash(oldBody)===payloadHash(newBody))continue;}}
  insertExact(db,'records',value,['partition','kind','id']);
 }
 for(const s of bundle.scopes)db.prepare('UPDATE scopes SET state_revision=max(state_revision,?) WHERE partition=?').run(s.state_revision,mapping.get(s.partition));
 for(const b of bundle.blobs)insertExact(db,'raw_blobs',{owner_id:account.owner_id,sha256:b.sha256,bytes:Buffer.from(b.bytes,'base64')},['owner_id','sha256']);
 for(const c of bundle.conversations)insertExact(db,'chat_conversations',{...c,partition:mapping.get(c.partition),actor_id:account.actor_id},['id']);
 for(const r of bundle.requests)insertExact(db,'chat_requests',r,['id']);
 for(const e of bundle.events)insertExact(db,'chat_events',e,['request_id','sequence']);
 for(const g of bundle.grants)insertExact(db,'model_execution_grants',{...g,token_hash:hash('retired:'+bundle.sha256+g.id),body_json:JSON.stringify({...JSON.parse(g.body_json),status:'completed'})},['id']);
 for(const c of bundle.calls)insertExact(db,'model_execution_calls',{...c,response:c.response?Buffer.from(c.response,'base64'):null},['id']);
}
function appendProjects(repository,directory,account,bundle){
 const file=join(directory,'accounts',account.id,'projects.json');
 if(!existsSync(file))throw Error('请先用原线上账号登录一次，再离线迁移。');
 const catalog=JSON.parse(readFileSync(file,'utf8')),caps=['read_memory','write_memory','review_memory','prepare_task','record_result','execute'];
 const dir=join(directory,'accounts',account.id,'connections','history-'+bundle.sha256);mkdirSync(dir,{recursive:true,mode:0o700});
 for(const project of bundle.projects){
  if(catalog.entries.some(x=>payloadHash(x.scope)===payloadHash(project.scope)))continue;
  const index=catalog.entries.length,files={uiTokenFile:join(dir,index+'-ui-token'),agentTokenFile:join(dir,index+'-codex-token')};
  for(const[k,actorId,kind,capabilities]of[['uiTokenFile',account.actor_id,'ui',caps],['agentTokenFile','codex-host','agent',['read_memory','write_memory','prepare_task','record_result']]]){
   const c=repository.createCredential({ownerId:account.owner_id,actorId,scope:project.scope,kind,capabilities});writeFileSync(files[k],c.token,{mode:0o600});
  }
  catalog.entries.push({...project,...files,requestId:'history:'+bundle.sha256+':'+index,status:'ready'});
 }
 const temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(catalog,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temp,file);
}
export function importHistory(directory,bundle,{archiveIncompleteChats=false}={}){
 verifyBundle(bundle);if(!archiveIncompleteChats&&bundle.requests.some(r=>r.status==='unknown'))throw Error('导出包含未完整返回的历史对话，需要明确选择保留未完成记录；不会重新发送。');const lease=acquireWorkspaceLease(directory),receiptDir=join(directory,'history-imports'),receipt=join(receiptDir,bundle.sha256+'.json');let db,repository;
 try{
  if(existsSync(receipt))return JSON.parse(readFileSync(receipt,'utf8'));
  db=new DatabaseSync(join(directory,'workspace.sqlite'));db.exec('PRAGMA foreign_keys=ON;BEGIN IMMEDIATE');idle(db,{archiveIncompleteChats});
  const a=db.prepare('SELECT id,owner_id,actor_id FROM workspace_accounts WHERE lower(email)=? AND active=1').get(identity(bundle.email));
  if(!a)throw Error('目标站点没有相同邮箱的账号，未导入。');
  if(!existsSync(join(directory,'accounts',a.id,'projects.json')))throw Error('目标账号尚未建立项目入口。');
  importRows(db,bundle,a);db.exec('COMMIT');db.close();db=null;
  repository=new WorkspaceRepository({dataDir:directory});appendProjects(repository,directory,a,bundle);
  const result={format:bundle.format,fingerprint:bundle.sha256,projects:bundle.projects.length,records:bundle.records.length,conversations:bundle.conversations.length,files:bundle.blobs.length,modelCalls:0,credentialsTransferred:false};
  mkdirSync(receiptDir,{recursive:true,mode:0o700});writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{mode:0o600,flag:'wx'});return result;
 }finally{if(db?.isTransaction)db.exec('ROLLBACK');db?.close();repository?.close();lease.close();}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const[action,directory,value,output]=process.argv.slice(2);if(['export','export-legacy'].includes(action)){const bundle=exportHistory(directory,value,{legacy:action==='export-legacy'});writeFileSync(output,JSON.stringify(bundle),{mode:0o600,flag:'wx'});console.log('已导出完整结束的项目记录；不含登录凭据和模型密钥。');}else if(action==='import')console.log(JSON.stringify(importHistory(directory,JSON.parse(readFileSync(value,'utf8')))));else throw Error('请选择 export 或 import。');}catch(e){console.error(e.message);process.exitCode=1;}
}
