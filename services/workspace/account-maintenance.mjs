import {accountInput,accountError} from './account-security.mjs';
export async function handleAccountMaintenance({action,input,ip,req,res,port,send,store,mailer,session}){
 if(action==='reset-code'){
  accountInput(input,['email']);if(!mailer.ready())throw accountError('网站暂未设置发件邮箱，请联系维护人员。',503);
  send(res,200,await store.sendResetCode(input.email,ip,message=>mailer.send(message)));return true;
 }
 if(action==='reset-password'){
  accountInput(input,['email','code','password']);send(res,200,await store.resetPassword(input,ip));return true;
 }
 if(action==='set-name'){
  accountInput(input,['username']);const current=await session(req,port);
  if(!current)throw accountError('请先登录，再设置登录名。',403);
  store.limit('name:'+current.account.id,10,300_000);
  const account=store.setName(current.account.id,input.username);
  send(res,200,{account:{id:account.id,email:account.email,username:account.username}});return true;
 }
 return false;
}

export function accountLogin(store,input,ip){
 accountInput(input,['email','identifier','password']);
 if(input.email!==undefined&&input.identifier!==undefined)throw accountError('请只填写一个登录名或邮箱。');
 return store.login(input.identifier??input.email,input.password,ip);
}
