import {fileURLToPath} from 'node:url';
// Reuses AgentHub core/email.py's SMTP / Resend transport choices. SMTP runs
// only Python's standard library; no FastAPI, Redis or third-party mail SDK.
import {spawn} from 'node:child_process';
import {openSync,closeSync,fstatSync,readFileSync,writeFileSync,constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {join} from 'node:path';
import {accountError} from './account-security.mjs';
function privateBytes(file){const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW);try{const s=fstatSync(fd);if(!s.isFile()||s.uid!==process.getuid()||s.mode&0o077||s.nlink!==1||s.size>16384)throw Error('Unsafe account configuration');return readFileSync(fd);}finally{closeSync(fd);}}
export function accountKey(dataDir){
 const file=join(dataDir,'account-key');try{writeFileSync(file,randomBytes(32),{flag:'wx',mode:0o600});}catch(error){if(error.code!=='EEXIST')throw error;}
 const bytes=privateBytes(file);if(bytes.length!==32)throw accountError('账号安全资料需要维护人员核对。',503);return bytes;
}
export function mailConfiguration(dataDir){
 let config;try{config=JSON.parse(privateBytes(join(dataDir,'account-mail.json')));}catch(error){if(error.code==='ENOENT')return null;throw accountError('邮件设置需要维护人员核对。',503);}
 if(!config||!['smtp','resend'].includes(config.provider)||typeof config.from!=='string'||!config.from.includes('@')||/[\r\n]/.test(config.from))throw accountError('发件邮箱设置不完整。',503);
 if(config.provider==='resend'&&(typeof config.apiKey!=='string'||!config.apiKey||/[\r\n]/.test(config.apiKey)))throw accountError('发件服务设置不完整。',503);
 if(config.provider==='smtp'&&(typeof config.host!=='string'||!/^[a-z0-9.-]+$/i.test(config.host)||!Number.isSafeInteger(config.port)||config.port<1||config.port>65535||![465,587,2525].includes(config.port)))throw accountError('发件服务器设置不完整，请使用加密邮件服务。',503);
 return config;
}
export function createAccountMailer(dataDir,{python=process.env.SYNPLEX_MAIL_PYTHON??'python3'}={}){
 return {ready:()=>{try{return !!mailConfiguration(dataDir);}catch{return false;}},async send(message){
  const config=mailConfiguration(dataDir);if(!config)throw accountError('网站暂未设置发件邮箱，请联系维护人员；已有账号仍可登录。',503);
  if(config.provider==='resend'){
   const response=await fetch('https://api.resend.com/emails',{method:'POST',redirect:'error',headers:{Authorization:'Bearer '+config.apiKey,'Content-Type':'application/json'},body:JSON.stringify({from:config.from,to:[message.to],subject:message.subject,text:message.text}),signal:AbortSignal.timeout(15000)});
   await response.body?.cancel();if(!response.ok)throw accountError('邮件服务暂时无法发送验证码。',503);return;
  }
  await new Promise((resolve,reject)=>{
   const child=spawn(python,['-I','-B',fileURLToPath(new URL('./account-smtp.py',import.meta.url))],{stdio:['pipe','ignore','ignore'],env:{PATH:process.env.PATH??''},timeout:20000});
   child.once('error',reject);child.once('close',code=>code===0?resolve():reject(accountError('邮件服务暂时无法发送验证码。',503)));child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({config,message}));
  });
 }};
}
