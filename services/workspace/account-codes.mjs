import {randomUUID,randomInt,createHmac,createHash,timingSafeEqual} from 'node:crypto';
import {accountError,emailAddress} from './account-security.mjs';
const digest=value=>createHash('sha256').update(value).digest('hex');
export class AccountCodes{
 constructor(store,purpose){
  if(!['register','reset'].includes(purpose))throw Error('Unknown verification purpose');
  this.store=store;this.purpose=purpose;this.table=purpose==='register'?'account_codes':'account_reset_codes';
 }
 hash(email,nonce,code){
  // Keep existing registration codes valid; reset codes use a separate domain.
  const prefix=this.purpose==='reset'?'reset\0':'';
  return createHmac('sha256',this.store.codeKey()).update(prefix+email+'\0'+nonce+'\0'+code).digest('hex');
 }
 async send(value,ip,sender){
  const email=emailAddress(value),store=this.store;store.limit('mail-ip:'+digest(ip),10,60_000);store.limit('mail-email:'+digest(email),1,60_000);
  const exists=store.db.prepare('SELECT 1 FROM workspace_accounts WHERE email=? AND active=1').get(email);
  if(this.purpose==='register'&&exists)throw accountError('这个邮箱已注册，请直接登录。',409);
  if(this.purpose==='reset'&&!exists)return {ok:true,retryAfter:60};
  const nonce=randomUUID(),code=String(randomInt(0,1000000)).padStart(6,'0');
  store.db.prepare(`INSERT INTO ${this.table} VALUES(?,?,?,?,0,0) ON CONFLICT(email) DO UPDATE SET nonce=excluded.nonce,code_hash=excluded.code_hash,expires_at=excluded.expires_at,attempts=0,delivered=0`).run(email,nonce,this.hash(email,nonce,code),store.clock()+300_000);
  const action=this.purpose==='reset'?'重置密码':'注册';
  try{await sender({to:email,subject:'Synplex '+action+'验证码',text:`你正在${action}。验证码是：${code}，5分钟内有效。请勿将验证码告诉他人。如果不是你本人操作，请忽略此邮件。`});}
  catch{store.db.prepare(`DELETE FROM ${this.table} WHERE email=? AND nonce=?`).run(email,nonce);throw accountError('验证码未能发出，请稍后重试或联系网站维护人员。',503);}
  store.db.prepare(`UPDATE ${this.table} SET delivered=1 WHERE email=? AND nonce=?`).run(email,nonce);return {ok:true,retryAfter:60};
 }
 verify(email,code){
  const row=this.store.db.prepare(`SELECT * FROM ${this.table} WHERE email=?`).get(email);
  const valid=row&&row.delivered&&row.expires_at>this.store.clock()&&row.attempts<5&&typeof code==='string'&&/^\d{6}$/.test(code)&&timingSafeEqual(Buffer.from(row.code_hash),Buffer.from(this.hash(email,row.nonce,code)));
  if(!valid){this.store.db.prepare(`UPDATE ${this.table} SET attempts=attempts+1 WHERE email=?`).run(email);throw accountError('验证码不正确或已过期，请检查邮件或重新获取。');}
  return row.nonce;
 }
 consume(email){this.store.db.prepare(`DELETE FROM ${this.table} WHERE email=?`).run(email);}
}
