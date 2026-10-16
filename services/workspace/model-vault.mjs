import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,existsSync,constants} from 'node:fs';
import {join} from 'node:path';
import {randomBytes,randomUUID,createCipheriv,createDecipheriv,createHmac} from 'node:crypto';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {modelFailure,validateConnection,validateSecret,validateSelection} from './model-contract.mjs';

export const MODEL_TABLES=['model_connections','model_connection_receipts','model_connection_holds'];
function privateMaster(dataDir,create){
  const path=join(dataDir,'model-vault-key');
  if(create){try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}}
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.nlink!==1||s.size!==32)throw Error('Unsafe model master key');return readFileSync(fd);}finally{closeSync(fd);}
}
export const modelPrivateToken=(dataDir,purpose)=>createHmac('sha256',privateMaster(dataDir,false)).update('synplex.private-token/1:'+purpose).digest('base64url');
function openSecret(row,key){
  const [iv,tag,bytes]=row.secret.split('.').map(v=>Buffer.from(v,'base64')),decipher=createDecipheriv('aes-256-gcm',key,iv);
  decipher.setAAD(Buffer.from(row.id+':'+row.revision));decipher.setAuthTag(tag);return Buffer.concat([decipher.update(bytes),decipher.final()]).toString('utf8');
}
export function verifyModelData(db,dataDir){
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='model_connections'").get())return;
  const rows=db.prepare('SELECT * FROM model_connections WHERE deleted=0').all();if(!rows.length)return;
  try{const key=privateMaster(dataDir,false);for(const row of rows)validateSecret(openSecret(row,key));}
  catch{throw modelFailure('模型连接与安全资料不一致，尚未完成备份核对。','请保留原目录和原密钥，从完整备份恢复。','conflict');}
}
export class ModelVault{
  #db;#dataDir;
  constructor(db,dataDir){
    this.#db=db;this.#dataDir=dataDir;
    db.exec(`CREATE TABLE IF NOT EXISTS model_connections(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,actor_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,deleted INTEGER NOT NULL DEFAULT 0,config_json TEXT NOT NULL,secret TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS model_owner ON model_connections(owner_id,actor_id,kind);
      CREATE TABLE IF NOT EXISTS model_connection_receipts(owner_id TEXT NOT NULL,actor_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,result_json TEXT NOT NULL,PRIMARY KEY(owner_id,actor_id,request_id));
      CREATE TABLE IF NOT EXISTS model_connection_holds(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL REFERENCES model_connections(id),revision INTEGER NOT NULL,owner_id TEXT NOT NULL,actor_id TEXT NOT NULL,released INTEGER NOT NULL DEFAULT 0);`);
  }
  #key(create=false){
    if(create&&!existsSync(join(this.#dataDir,'model-vault-key'))&&this.#db.prepare('SELECT 1 FROM model_connections LIMIT 1').get())throw modelFailure('模型连接的安全资料缺失。','请保留现有连接，并从完整备份恢复。','capability_unavailable');
    return privateMaster(this.#dataDir,create);
  }
  #seal(secret,id,revision){
    const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.#key(true),iv);cipher.setAAD(Buffer.from(id+':'+revision));
    const ciphertext=Buffer.concat([cipher.update(secret,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),ciphertext].map(b=>b.toString('base64')).join('.');
  }
  #open(row){
    try{return openSecret(row,this.#key());}
    catch{throw modelFailure('这份模型连接暂时无法读取。','请保留原连接，并由维护人员核对安全备份。','capability_unavailable');}
  }
  #public(row){return {id:row.id,kind:row.kind,revision:row.revision,enabled:!!row.enabled,...JSON.parse(row.config_json),verification:'not_tested',credential:'已保存',createdAt:row.created_at,updatedAt:row.updated_at};}
  #owned(auth,id,admin=false){
    const row=this.#db.prepare('SELECT * FROM model_connections WHERE id=? AND deleted=0').get(id);
    const own=row?.owner_id===auth.ownerId&&row?.actor_id===auth.actorId;
    if(!row||!own||row.kind==='builtin'&&!admin)throw modelFailure('没有这份模型连接的管理权限。','请选择自己的连接。','scope_denied');return row;
  }
  #usable(auth,id){
    const row=this.#db.prepare('SELECT * FROM model_connections WHERE id=? AND deleted=0').get(id);
    if(!row||!row.enabled||row.owner_id!==auth.ownerId||row.kind!=='builtin'&&row.actor_id!==auth.actorId)throw modelFailure('这个模型连接不可用。','请选择可用模型或检查自己的连接。','scope_denied');return row;
  }
  #idle(row){if(this.#db.prepare('SELECT 1 FROM model_connection_holds WHERE connection_id=? AND released=0 LIMIT 1').get(row.id))throw modelFailure('仍有任务在使用这份模型连接。','请先结束或核对原任务，再修改连接。','conflict');}
  #mutation(auth,requestId,input,fn){
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(requestId))throw modelFailure('操作未能识别，请重新打开模型设置。');
    // Keyed request digest: never store a raw key or an offline-testable key hash.
    const hash=createHmac('sha256',this.#key(true)).update(payloadHash(input)).digest('hex');
    this.#db.exec('BEGIN IMMEDIATE');
    try{
      const previous=this.#db.prepare('SELECT * FROM model_connection_receipts WHERE owner_id=? AND actor_id=? AND request_id=?').get(auth.ownerId,auth.actorId,requestId);
      if(previous){if(previous.input_hash!==hash)throw modelFailure('这次操作的内容发生了变化。','请先查看原来的保存结果。','conflict');this.#db.exec('COMMIT');return JSON.parse(previous.result_json);}
      const value=fn();this.#db.prepare('INSERT INTO model_connection_receipts VALUES(?,?,?,?,?)').run(auth.ownerId,auth.actorId,requestId,hash,JSON.stringify(value));this.#db.exec('COMMIT');return value;
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  list(auth){return this.#db.prepare("SELECT * FROM model_connections WHERE deleted=0 AND owner_id=? AND (kind='builtin' OR actor_id=?) ORDER BY created_at,id").all(auth.ownerId,auth.actorId).map(row=>this.#public(row));}
  save(auth,{requestId,id=null,revision=null,kind='personal',config,secret},admin=false){
    const checked=validateConnection(config);if(secret!==null)validateSecret(secret);
    if(!['personal','builtin'].includes(kind)||kind==='builtin'&&!admin)throw modelFailure('没有内置模型的管理权限。','请添加自己的模型。','scope_denied');
    return this.#mutation(auth,requestId,{id,revision,kind,config:checked,secret},()=>{
      const previous=id===null?null:this.#owned(auth,id,admin);
      if(previous){this.#idle(previous);if(previous.revision!==revision||previous.kind!==kind)throw modelFailure('模型设置已更新。','请重新打开当前设置。','conflict');}
      if(secret===null){
        const prior=previous&&JSON.parse(previous.config_json);
        if(!prior||prior.endpoint!==checked.endpoint||prior.protocol!==checked.protocol)throw modelFailure('更换服务地址或连接方式时，请重新填写密钥。');
      }
      const nextRevision=previous?previous.revision+1:1,nextId=previous?.id??randomUUID(),time=new Date().toISOString(),sealed=this.#seal(secret===null?this.#open(previous):secret,nextId,nextRevision);
      if(previous)this.#db.prepare('UPDATE model_connections SET revision=?,config_json=?,secret=?,updated_at=? WHERE id=?').run(nextRevision,JSON.stringify(checked),sealed,time,nextId);
      else this.#db.prepare('INSERT INTO model_connections VALUES(?,?,?,?,?,1,0,?,?,?,?)').run(nextId,auth.ownerId,auth.actorId,kind,nextRevision,JSON.stringify(checked),sealed,time,time);
      return this.#public(this.#db.prepare('SELECT * FROM model_connections WHERE id=?').get(nextId));
    });
  }
  change(auth,{requestId,id,revision,action},admin=false){
    if(!['enable','disable','delete'].includes(action))throw modelFailure('请选择启用、停用或删除。');
    return this.#mutation(auth,requestId,{id,revision,action},()=>{
      const row=this.#owned(auth,id,admin);this.#idle(row);
      if(row.revision!==revision)throw modelFailure('模型设置已更新。','请重新打开当前设置。','conflict');
      // Revision authenticates ciphertext; changing metadata needs resealing too.
      const next=revision+1,sealed=action==='delete'?'':this.#seal(this.#open(row),id,next);
      this.#db.prepare('UPDATE model_connections SET revision=?,enabled=?,deleted=?,secret=?,updated_at=? WHERE id=?').run(next,action==='enable'?1:0,action==='delete'?1:0,sealed,new Date().toISOString(),id);
      return {id,revision:next,enabled:action==='enable',deleted:action==='delete'};
    });
  }
  acquire(auth,selection,holdId,{tools=false}={}){
    if(typeof holdId!=='string'||holdId.length<1||holdId.length>128)throw modelFailure('任务编号无法识别。');
    this.#db.exec('BEGIN IMMEDIATE');
    try{
      const row=this.#usable(auth,selection.connectionId),binding=validateSelection(this.#public(row),selection,{tools}),secret=this.#open(row);
      const existing=this.#db.prepare('SELECT * FROM model_connection_holds WHERE id=?').get(holdId);
      if(existing&&(existing.released||existing.connection_id!==row.id||existing.revision!==row.revision||existing.owner_id!==auth.ownerId||existing.actor_id!==auth.actorId))throw modelFailure('原任务的模型连接需要核对。','请查看原任务，不要重新发送。','conflict');
      this.#db.prepare('INSERT OR IGNORE INTO model_connection_holds VALUES(?,?,?,?,?,0)').run(holdId,row.id,row.revision,auth.ownerId,auth.actorId);this.#db.exec('COMMIT');
      return {binding,endpoint:JSON.parse(row.config_json).endpoint,secret};
    }catch(error){this.#db.exec('ROLLBACK');throw error;}
  }
  release(auth,holdId){this.#db.prepare('UPDATE model_connection_holds SET released=1 WHERE id=? AND owner_id=? AND actor_id=?').run(holdId,auth.ownerId,auth.actorId);}
}
