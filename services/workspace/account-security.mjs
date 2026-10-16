import {randomBytes,scrypt as derive,timingSafeEqual} from 'node:crypto';
import {promisify} from 'node:util';
import {ProtocolError} from '../../packages/contracts/validate.mjs';
const scrypt=promisify(derive);let hashing=0;
class AccountError extends ProtocolError{}
export function accountError(message,status=400){const error=new AccountError(status===403?'scope_denied':status===503?'capability_unavailable':'validation_failed',message,'请根据提示重试；已有资料和任务会保留。','after_input');error.httpStatus=status;return error;}
export function emailAddress(value){
 if(typeof value!=='string'||value.length>254)throw accountError('请输入正确的邮箱。');
 const email=value.trim().toLowerCase();if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||/[\r\n\x00-\x1f]/.test(email))throw accountError('请输入正确的邮箱。');return email;
}
export function accountInput(value,fields){
 if(!value||Array.isArray(value)||typeof value!=='object'||Object.keys(value).some(k=>!fields.includes(k)))throw accountError('提交内容不完整，请重新填写。');return value;
}
export function passwordValue(value){if(typeof value!=='string'||value.length<8||Buffer.byteLength(value)>1024)throw accountError('密码需至少8位，且不能超过1024字节。');return value;}
async function key(password,salt){
 if(hashing>=4)throw accountError('登录人数较多，请稍后再试。',429);hashing++;
 try{return await scrypt(password,salt,32,{N:16384,r:8,p:1,maxmem:64*1024*1024});}finally{hashing--;}
}
export async function passwordHash(value){const salt=randomBytes(16).toString('hex');return 'scrypt$'+salt+'$'+(await key(passwordValue(value),salt)).toString('hex');}
export async function passwordMatches(value,stored){
 if(typeof value!=='string'||Buffer.byteLength(value)>1024)return false;
 const [method,salt,hash]=String(stored??'scrypt$00000000000000000000000000000000$'+'00'.repeat(32)).split('$');
 if(method!=='scrypt'||!/^[a-f0-9]{32}$/.test(salt)||!/^[a-f0-9]{64}$/.test(hash))throw accountError('账号安全资料需要维护人员核对。',503);
 return timingSafeEqual(await key(value,salt),Buffer.from(hash,'hex'));
}

export const safeAccountFailure=(error,operationId=null)=>error instanceof AccountError?{code:error.code,message:error.message,nextAction:error.nextAction,retry:error.retry,operationId}:null;

export function loginName(value){
 if(typeof value!=='string'||!(/^[a-zA-Z][a-zA-Z0-9_-]{2,31}$/).test(value.trim()))throw accountError('登录名需为3到32位，以字母开头，可使用字母、数字、下划线或短横线。');
 return value.trim().toLowerCase();
}
export function loginIdentifier(value){
 if(typeof value!=='string')throw accountError('请输入登录名或邮箱。');
 return value.includes('@')?emailAddress(value):loginName(value);
}
