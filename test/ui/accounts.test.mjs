import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createAccounts} from '../../services/workspace/accounts.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {DatabaseSync} from 'node:sqlite';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as context from '../../packages/context/index.mjs';
const protocolVersion='synplex.workspace/1.0.0',scope={projectId:'legacy-private',versionId:null,branchId:null};
const config={name:'私有内置连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:256,models:[{id:'model',name:'型号',pricing:null,capabilities:{tools:true,stream:false,efforts:[],contextWindow:32000}}]};
test('email registration, password login, restart, exact tenant/project/model/source/chat isolation, extension and logout',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-accounts-'));let repository,server,url;const mail=[];let time=Date.now();
 function start(){
  repository=new WorkspaceRepository({dataDir});repository.accounts({clock:()=>time});
  const connection=initialConnection(repository,{dataDir,scope,port:5448}),rootAuth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8'));
  const projects=new LocalProjects({repository,dataDir,connection,rootAuth,allowExecution:true});
  const accounts=createAccounts({repository,dataDir,localProjects:projects,allowExecution:true,mailer:{ready:()=>true,send:async message=>mail.push(message)}});
  server=createWorkspaceServer({repository,localProjects:projects,accounts,modules:{ingestion,context},modelAdmin:auth=>accounts.admin(auth)});return {rootAuth,connection};
 }
 let root=start();url=await server.listen();
 t.after(async()=>{await server?.close();repository?.close();rmSync(dataDir,{recursive:true,force:true});});
 const post=async(action,input,cookie='')=>{const response=await fetch(url+'/api/v1/'+action,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(input)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 const bootstrap=async cookie=>{const response=await fetch(url+'/api/v1/ui_bootstrap',{headers:{Cookie:cookie}});return {status:response.status,body:await response.json()};};
 const code=email=>mail.findLast(m=>m.to===email).text.match(/\d{6}/)[0];
 const register=async(email,extra={})=>{assert.equal((await post('auth/send-code',{email})).status,200);if(email==='alpha@example.com')assert.equal((await post('auth/register',{email,password:'synthetic-password',code:code(email),inheritLocal:true})).status,403);return post('auth/register',{email,password:'synthetic-password',code:code(email),...extra});};
 assert.equal((await bootstrap('')).status,403);
 const alpha=await register('alpha@example.com');assert.equal(alpha.status,201,JSON.stringify(alpha));assert.ok(alpha.cookie);assert.equal(JSON.stringify(alpha).includes('password'),false);
 const one=await bootstrap(alpha.cookie);assert.equal(one.status,200);assert.notEqual(one.body.scope.projectId,scope.projectId);assert.equal(one.body.projects.length,1);
 const a=one.body.scope,acall=(action,input={})=>post(action,{protocolVersion,scope:a,...input},alpha.cookie);
 const built=await acall('ui_save_model',{requestId:'model-save',kind:'builtin',config,secret:'synthetic-secret-alpha'});assert.equal(built.status,200,JSON.stringify(built));
 const draft=await acall('ui_chat_create',{requestId:'chat-a'});assert.equal(draft.status,200,JSON.stringify(draft));
 const bytes=new TextEncoder().encode('决定：保留甲的私人材料。'),form=new FormData();
 form.set('metadata',JSON.stringify({protocolVersion,scope:a,requestId:'import-a',expectedStateRevision:0,format:'text/plain',sourceSystem:'user-text',formatVersion:'1',sessionId:null,eventId:'source-event',occurredAt:null}));form.set('source',new Blob([bytes]),'private.txt');
 const admitted=await fetch(url+'/api/v1/import_source',{method:'POST',headers:{Cookie:alpha.cookie},body:form});assert.ok([200,201,202].includes(admitted.status),await admitted.clone().text());await server.service.idle();
 const ah=await acall('ui_history');assert.equal(ah.body.sources.length,1);
 const beta=await register('beta@example.com');assert.equal(beta.status,201);const two=await bootstrap(beta.cookie),b=two.body.scope;
 const bcall=(action,input={})=>post(action,{protocolVersion,scope:b,...input},beta.cookie);
 assert.equal((await bcall('ui_models')).body.connections.length,0);
 assert.equal((await bcall('ui_change_model',{requestId:'steal-model',id:built.body.connection.id,revision:1,action:'disable'})).status,403);
 assert.equal((await bcall('ui_history',{scope:a})).status,403);
 assert.equal((await bcall('ui_select_project',{scope:a})).status,403);
 assert.equal((await bcall('ui_extension',{scope:a,host:'codex'})).status,403);
 assert.equal((await bcall('ui_chat_history',{conversationId:draft.body.id,cursor:null})).status,403);
 assert.equal((await bcall('ui_history')).body.sources.length,0);
 assert.equal((await bcall('auth/register',{email:'thief@example.com',password:'synthetic-password',code:'000000',inheritLocal:true})).status,400);
 const project=await bcall('ui_create_project',{requestId:'next',name:'乙的项目'});assert.equal(project.status,200);
 const selectedScope=project.body.scope;assert.notEqual(selectedScope.projectId,a.projectId);
 const sessionBefore=alpha.cookie,secondCookie=beta.cookie;
 await server.close();repository.close();root=start();url=await server.listen();
 // Cookie includes port: update name only, preserving the same secret. This
 // simulates restart on the normal fixed port without binding a busy port.
 const move=cookie=>cookie.replace(/^synplex_ui_\d+=/,'synplex_ui_'+new URL(url).port+'=');
 alpha.cookie=move(sessionBefore);beta.cookie=move(secondCookie);
 assert.equal((await bootstrap(alpha.cookie)).body.projects.length,1);assert.deepEqual((await bootstrap(beta.cookie)).body.scope,selectedScope);
 const betaLogin=await post('auth/login',{email:'beta@example.com',password:'synthetic-password'});assert.equal(betaLogin.status,200);assert.deepEqual((await bootstrap(betaLogin.cookie)).body.scope,selectedScope,'重新登录保留上次使用的本人项目');
 const bad=await post('auth/login',{email:'ALPHA@example.com',password:'wrong-password'});assert.equal(bad.status,403);
 const login=await post('auth/login',{email:' ALPHA@example.com ',password:'synthetic-password'});assert.equal(login.status,200);assert.equal((await bootstrap(login.cookie)).status,200);
 assert.equal((await post('auth/logout',{},login.cookie)).status,200);assert.equal((await bootstrap(login.cookie)).status,403);
 const db=new DatabaseSync(join(dataDir,'workspace.sqlite'),{readOnly:true});try{
  const rows=db.prepare('SELECT * FROM workspace_accounts').all();assert.equal(rows.length,2);assert.ok(rows.every(r=>r.password_hash.startsWith('scrypt$')));assert.equal(JSON.stringify(rows).includes('synthetic-password'),false);
  assert.equal(db.prepare('SELECT count(*) n FROM account_codes').get().n,0);assert.equal(JSON.stringify(db.prepare('SELECT * FROM account_sessions').all()).includes(login.cookie.split('=')[1]),false);
 }finally{db.close();}
});

test('codes are single use, expire, lock after five failures, resend is limited; local data requires an explicit paired claim',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-account-codes-')),repository=new WorkspaceRepository({dataDir});t.after(()=>{repository.close();rmSync(dataDir,{recursive:true,force:true});});
 let time=Date.now();const store=repository.accounts({clock:()=>time}),mail=[];const send=email=>store.sendCode(email,'test-ip',async message=>mail.push(message)),code=()=>mail.at(-1).text.match(/\d{6}/)[0],payload=email=>({email,password:'synthetic-password',code:code()});
 await send('lock@example.com');await assert.rejects(send('lock@example.com'),/次数/);
 for(let i=0;i<5;i++)await assert.rejects(store.register({...payload('lock@example.com'),code:code()==='000000'?'000001':'000000'},'ip-'+i),/验证码/);
 await assert.rejects(store.register(payload('lock@example.com'),'ip-x'),/验证码/);
 time+=60001;await send('lock@example.com');time+=300001;await assert.rejects(store.register(payload('lock@example.com'),'ip-y'),/验证码/);
 time+=60001;await send('race@example.com');const input=payload('race@example.com');const both=await Promise.allSettled([store.register(input,'p1'),store.register(input,'p2')]);assert.equal(both.filter(x=>x.status==='fulfilled').length,1);
 await assert.rejects(store.register(input,'p3'),/验证码|已注册/);
 const connection=initialConnection(repository,{dataDir,scope,port:5449}),auth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8'));
 await send('owner@example.com');const claimed=await store.register(payload('owner@example.com'),'owner-ip',auth);assert.equal(claimed.ownerId,'local-owner');assert.deepEqual(claimed.scope,scope);assert.equal(store.claimAvailable('local-owner'),false);
 await assert.rejects(store.sendCode('failure@example.com','f1',async()=>{throw Error('Mail failed');}),/未能发出/);await assert.rejects(store.register({email:'failure@example.com',password:'synthetic-password',code:'000000'},'f2'),/验证码/);
});

test('registration faults return clear safe messages and no code, key, cookie or provider exception',async()=>{
 const {safeError}=await import('../../services/workspace/service.mjs');
 const {accountError}=await import('../../services/workspace/account-security.mjs');
 assert.equal(safeError(accountError('账号或密码不正确，请检查后重试。',403)).message,'账号或密码不正确，请检查后重试。');
 assert.equal(safeError(accountError('网站暂未设置发件邮箱，请联系维护人员；已有账号仍可登录。',503)).code,'capability_unavailable');
 assert.equal(safeError(Error('secret-smtp-provider-raw-failure')).message.includes('secret'),false);
});
