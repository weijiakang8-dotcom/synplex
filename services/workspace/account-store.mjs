import {randomUUID,randomBytes,createHash} from 'node:crypto';
import {accountError,emailAddress,passwordHash,passwordMatches,loginName,loginIdentifier} from './account-security.mjs';
import {AccountCodes} from './account-codes.mjs';
export const ACCOUNT_TABLES=['workspace_accounts','account_codes','account_limits','account_sessions','account_names','account_reset_codes','account_recovery_events'];
const digest=value=>createHash('sha256').update(value).digest('hex');
export const ACCOUNT_SESSION_SECONDS=7*24*3600;
// Same transaction domain as projects and records, including offline backups.
export class AccountStore{
 #passwordProof=new WeakMap();
 constructor(db,{codeKey,clock=Date.now}){
  this.db=db;this.codeKey=codeKey;this.clock=clock;
  db.exec(`CREATE TABLE IF NOT EXISTS workspace_accounts(id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_hash TEXT NOT NULL,owner_id TEXT NOT NULL UNIQUE,actor_id TEXT NOT NULL,scope_json TEXT NOT NULL,created_at INTEGER NOT NULL,active INTEGER NOT NULL DEFAULT 1);
   CREATE TABLE IF NOT EXISTS account_codes(email TEXT PRIMARY KEY,nonce TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS account_limits(key TEXT PRIMARY KEY,window_at INTEGER NOT NULL,count INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS account_sessions(token_hash TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES workspace_accounts(id),scope_json TEXT NOT NULL,expires_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS account_names(account_id TEXT PRIMARY KEY REFERENCES workspace_accounts(id),username TEXT NOT NULL UNIQUE COLLATE NOCASE);
   CREATE TABLE IF NOT EXISTS account_recovery_events(account_id TEXT PRIMARY KEY REFERENCES workspace_accounts(id),changed_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS account_reset_codes(email TEXT PRIMARY KEY,nonce TEXT NOT NULL,code_hash TEXT NOT NULL,expires_at INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0,delivered INTEGER NOT NULL DEFAULT 0);
   CREATE INDEX IF NOT EXISTS account_session_expiry ON account_sessions(expires_at);`);
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const value=fn();this.db.exec('COMMIT');return value;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 limit(key,maximum,period){
  const time=this.clock();this.db.prepare('DELETE FROM account_limits WHERE window_at<?').run(time-86400_000);
  const row=this.db.prepare('SELECT * FROM account_limits WHERE key=?').get(key),start=row&&row.window_at>time-period;
  if(start&&row.count>=maximum)throw accountError('尝试次数较多，请稍后再试。',429);
  this.db.prepare('INSERT INTO account_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET window_at=excluded.window_at,count=excluded.count').run(key,start?row.window_at:time,start?row.count+1:1);
 }
 sendCode(value,ip,sender){return new AccountCodes(this,'register').send(value,ip,sender);}
 sendResetCode(value,ip,sender){return new AccountCodes(this,'reset').send(value,ip,sender);}
 setName(id,value){
  const username=loginName(value),found=this.db.prepare('SELECT account_id FROM account_names WHERE username=? COLLATE NOCASE').get(username);
  if(found&&found.account_id!==id)throw accountError('这个登录名已被使用，请换一个。',409);
  if(!this.account(id))throw accountError('请重新登录后再修改登录名。',403);
  this.db.prepare('INSERT INTO account_names VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET username=excluded.username').run(id,username);return this.account(id);
 }
 async resetPassword({email:raw,password,code},ip){
  const email=emailAddress(raw);this.limit('reset-ip:'+digest(ip),10,300_000);
  const codes=new AccountCodes(this,'reset'),nonce=codes.verify(email,code),hash=await passwordHash(password);
  this.transaction(()=>{
   if(codes.verify(email,code)!==nonce)throw accountError('验证码已更新，请使用最近收到的一次。');
   const account=this.db.prepare('SELECT id FROM workspace_accounts WHERE email=? AND active=1').get(email);
   if(!account)throw accountError('验证码不正确或已过期，请检查邮件或重新获取。');
   this.db.prepare('UPDATE workspace_accounts SET password_hash=? WHERE id=?').run(hash,account.id);
   this.db.prepare('INSERT INTO account_recovery_events VALUES(?,?) ON CONFLICT(account_id) DO UPDATE SET changed_at=excluded.changed_at').run(account.id,this.clock());
   this.db.prepare('DELETE FROM account_sessions WHERE account_id=?').run(account.id);codes.consume(email);
  });return {ok:true};
 }
 async register({email:raw,password,code,username},ip,identity=null){
  const email=emailAddress(raw);if(username!==undefined)loginName(username);this.limit('register-ip:'+digest(ip),10,300_000);
  // Verify before the expensive hash and again atomically afterwards. Failed
  // attempts commit; code consumption and account creation commit together.
  const codes=new AccountCodes(this,'register'),nonce=codes.verify(email,code),hash=await passwordHash(password);
  return this.transaction(()=>{
   if(this.db.prepare('SELECT 1 FROM workspace_accounts WHERE email=?').get(email))throw accountError('这个邮箱已注册，请直接登录。',409);
   if(codes.verify(email,code)!==nonce)throw accountError('验证码已更新，请使用最近收到的一次。');
   const id=randomUUID(),ownerId=identity?.ownerId??'tenant:'+id,actorId=identity?.actorId??'account:'+id,scope=identity?.authorizedScope??{projectId:randomUUID(),versionId:null,branchId:null};
   if(this.db.prepare('SELECT 1 FROM workspace_accounts WHERE owner_id=?').get(ownerId))throw accountError('已有项目已绑定账号，请使用原账号登录。',409);
   this.db.prepare('INSERT INTO workspace_accounts VALUES(?,?,?,?,?,?,?,1)').run(id,email,hash,ownerId,actorId,JSON.stringify(scope),this.clock());
   if(username!==undefined)this.setName(id,username);codes.consume(email);const account=this.account(id);this.#passwordProof.set(account,hash);return account;
  });
 }
 async login(value,password,ip){
  const identifier=loginIdentifier(value);this.limit('login-ip:'+digest(ip),30,300_000);
  const row=identifier.includes('@')?this.db.prepare('SELECT * FROM workspace_accounts WHERE email=?').get(identifier):this.db.prepare('SELECT a.* FROM workspace_accounts a JOIN account_names n ON n.account_id=a.id WHERE n.username=? COLLATE NOCASE').get(identifier);
  this.limit('login-account:'+digest(row?.id??identifier),5,300_000);
  const matches=await passwordMatches(password,row?.password_hash);
  if(!row||!matches||!row.active)throw accountError('账号或密码不正确，请检查后重试。',403);
  const account=this.account(row.id);if(!account)throw accountError('账号或密码不正确，请检查后重试。',403);this.#passwordProof.set(account,row.password_hash);return account;
 }
 account(id){const row=this.db.prepare('SELECT a.id,a.email,a.owner_id,a.actor_id,a.scope_json,n.username FROM workspace_accounts a LEFT JOIN account_names n ON n.account_id=a.id WHERE a.id=? AND a.active=1').get(id);return row?{id:row.id,email:row.email,username:row.username??null,ownerId:row.owner_id,actorId:row.actor_id,scope:JSON.parse(row.scope_json)}:null;}
 accounts(){return this.db.prepare('SELECT id FROM workspace_accounts WHERE active=1').all().map(row=>this.account(row.id));}
 admin(auth){return !!this.db.prepare('SELECT 1 FROM workspace_accounts WHERE owner_id=? AND actor_id=? AND active=1').get(auth.ownerId,auth.actorId);}
 claimAvailable(ownerId){return !this.db.prepare('SELECT 1 FROM workspace_accounts WHERE owner_id=?').get(ownerId);}
 issue(account){
  const proof=this.#passwordProof.get(account),row=this.db.prepare('SELECT password_hash FROM workspace_accounts WHERE id=? AND active=1').get(account.id);
  if(!row||proof&&proof!==row.password_hash)throw accountError('密码已更新，请使用新密码重新登录。',403);
  this.db.prepare('DELETE FROM account_sessions WHERE expires_at<=?').run(this.clock());
  const token=randomBytes(32).toString('hex');this.db.prepare('INSERT INTO account_sessions VALUES(?,?,?,?)').run(digest(token),account.id,JSON.stringify(account.scope),this.clock()+ACCOUNT_SESSION_SECONDS*1000);return token;
 }
 session(token){
  if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))return null;
  const row=this.db.prepare('SELECT * FROM account_sessions WHERE token_hash=? AND expires_at>?').get(digest(token),this.clock());if(!row)return null;
  const account=this.account(row.account_id);return account?{account,scope:JSON.parse(row.scope_json),sessionHash:row.token_hash}:null;
 }
 select(hash,scope){this.db.prepare('UPDATE account_sessions SET scope_json=? WHERE token_hash=?').run(JSON.stringify(scope),hash);}
 revoke(token){if(typeof token==='string')this.db.prepare('DELETE FROM account_sessions WHERE token_hash=?').run(digest(token));}
}
