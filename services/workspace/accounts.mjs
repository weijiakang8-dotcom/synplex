import {mkdirSync,readFileSync} from 'node:fs';
import {join} from 'node:path';
import {initialConnection} from './initial-connection.mjs';
import {LocalProjects} from './local-projects.mjs';
import {createAccountMailer} from './account-mail.mjs';
import {accountInput,accountError} from './account-security.mjs';
import {handleAccountMaintenance,accountLogin} from './account-maintenance.mjs';
import {ACCOUNT_SESSION_SECONDS} from './account-store.mjs';
import {uiSessionCookie,uiSessionCookieName} from './public-access.mjs';
const info=account=>({id:account.id,email:account.email,username:account.username});
const tokenFrom=(req,port)=>(req.headers.cookie??'').split(';').map(x=>x.trim()).find(x=>x.startsWith(uiSessionCookieName(port)+'='))?.split('=')[1];
export function createAccounts({repository,dataDir,localProjects,allowExecution=false,secureCookies=false,mailer=createAccountMailer(dataDir)}){
 const store=repository.accounts(),managers=new Map();
 function projectsFor(account){
  if(managers.has(account.id))return managers.get(account.id);
  if(account.ownerId===localProjects.rootAuth.ownerId){
   if(account.actorId!==localProjects.rootAuth.actorId)throw accountError('已有项目的账号归属需要核对。',403);
   managers.set(account.id,localProjects);return localProjects;
  }
  const dir=join(dataDir,'accounts',account.id);mkdirSync(dir,{recursive:true,mode:0o700});
  const port=Number(new URL(localProjects.endpoint).port),connection=initialConnection(repository,{dataDir:dir,port,scope:account.scope,ownerId:account.ownerId,actorId:account.actorId});
  const rootAuth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim());
  if(rootAuth.ownerId!==account.ownerId||rootAuth.actorId!==account.actorId)throw accountError('账号与项目的归属不一致，请联系维护人员。',403);
  const manager=new LocalProjects({repository,dataDir:dir,connection,rootAuth,allowExecution});managers.set(account.id,manager);return manager;
 }
 function claimOwner(legacy){return legacy?.rootAuth===localProjects.rootAuth&&store.claimAvailable(localProjects.rootAuth.ownerId)?localProjects.rootAuth:null;}
 async function session(req,port){
  const saved=store.session(tokenFrom(req,port));if(!saved)return null;
  const projects=projectsFor(saved.account),selected=await projects.select(projects.rootAuth,saved.scope);
  return {...selected,rootAuth:projects.rootAuth,projects,account:info(saved.account),sessionHash:saved.sessionHash};
 }
 function setCookie(res,port,token,maxAge=ACCOUNT_SESSION_SECONDS){return {'Set-Cookie':uiSessionCookie(token,{secureCookies,maxAge,port})};}
 async function handle({req,res,path,port,parseJSON,send,legacySession}){
  if(!path.startsWith('/api/v1/auth/'))return false;
  const action=path.slice('/api/v1/auth/'.length),legacy=legacySession();
  if(action==='status'&&req.method==='GET'){send(res,200,{enabled:true,mailReady:mailer.ready(),canClaimLocal:!!claimOwner(legacy)});return true;}
  if(req.method!=='POST')throw accountError('请通过页面提交账号信息。',405);
  const input=await parseJSON(req,8192),ip=req.socket.remoteAddress??'unknown';
  // Never trust a browser-supplied X-Forwarded-For. Account limits remain
  // effective behind the local proxy (a shared IP limit is conservative).
  if(await handleAccountMaintenance({action,input,ip,req,res,port,send,store,mailer,session}))return true;
  if(action==='send-code'){
   accountInput(input,['email']);if(!mailer.ready())throw accountError('网站暂未设置发件邮箱，请联系维护人员；已有账号仍可登录。',503);
   send(res,200,await store.sendCode(input.email,ip,message=>mailer.send(message)));return true;
  }
  if(action==='logout'){accountInput(input,[]);store.revoke(tokenFrom(req,port));send(res,200,{ok:true},setCookie(res,port,'',0));return true;}
  let account;
  if(action==='register'){
   accountInput(input,['email','password','code','inheritLocal','username']);if(input.inheritLocal!==undefined&&typeof input.inheritLocal!=='boolean')throw accountError('请重新选择是否带入已有项目。');
   const owner=input.inheritLocal?claimOwner(legacy):null;
   if(input.inheritLocal&&!owner)throw accountError('只有从本机私人入口打开原工作台的人才能绑定已有项目。',403);
   account=await store.register(input,ip,owner);
  }else if(action==='login'){account=await accountLogin(store,input,ip);}
  else throw accountError('没有这个账号操作。',404);
  const projects=projectsFor(account),selected=await projects.preferred(projects.rootAuth);
  store.revoke(tokenFrom(req,port));const token=store.issue(account,selected.scope);
  send(res,action==='register'?201:200,{account:info(account)},setCookie(res,port,token));return true;
 }
 return {handle,session,admin:auth=>store.admin(auth),selectSession:async(value,scope)=>{if(value.sessionHash){await value.projects.remember(value.rootAuth,scope);store.select(value.sessionHash,scope);}},
  async recover(recover){for(const account of store.accounts()){const manager=projectsFor(account);for(const p of await manager.list(manager.rootAuth)){const selected=await manager.select(manager.rootAuth,p.scope);await recover(selected);}}},
  metadata:value=>({enabled:true,account:value?.account??null,canClaimLocal:!!claimOwner(value)})};
}
