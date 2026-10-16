import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AccountStore} from '../../services/workspace/account-store.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createAccounts} from '../../services/workspace/accounts.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {requiredDataFeatures} from '../../scripts/runtime/data-compatibility.mjs';
const password='synthetic-password',updated='changed-synthetic-password';
function fixture(t){
 const db=new DatabaseSync(':memory:');t.after(()=>db.close());let time=Date.now();const store=new AccountStore(db,{codeKey:()=>Buffer.alloc(32,7),clock:()=>time}),mail=[];
 const sender=async message=>mail.push(message),code=()=>mail.at(-1).text.match(/\d{6}/)[0];
 return {db,store,mail,sender,code,tick:(ms=60001)=>time+=ms,async register(email,username){await store.sendCode(email,'register',sender);return store.register({email,username,password,code:code()},'register');}};
}
test('login names are unique, normalized and editable without changing owner, project or existing sessions',async t=>{
 const f=fixture(t),a=await f.register('alpha@example.com',' Alpha_01 '),b=await f.register('beta@example.com','beta');
 const token=f.store.issue(a);assert.equal(a.username,'alpha_01');assert.equal((await f.store.login('ALPHA_01',password,'ip')).id,a.id);
 assert.equal((await f.store.login(' ALPHA@example.com ',password,'ip')).id,a.id);
 assert.throws(()=>f.store.setName(b.id,'ALPHA_01'),/已被使用/);assert.throws(()=>f.store.setName(a.id,'@bad'),/登录名/);
 const changed=f.store.setName(a.id,'NewName');assert.equal(changed.username,'newname');assert.deepEqual(changed.scope,a.scope);assert.equal(changed.ownerId,a.ownerId);
 assert.equal(f.store.session(token).account.username,'newname');await assert.rejects(f.store.login('alpha_01',password,'old'),/账号或密码/);
 assert.equal((await f.store.login('newname',password,'new')).id,a.id);
 // Uniqueness remains atomic when asynchronous password hashing overlaps.
 await f.store.sendCode('third@example.com','third',f.sender);const third={email:'third@example.com',password,username:'same',code:f.code()};
 await f.store.sendCode('fourth@example.com','fourth',f.sender);const fourth={email:'fourth@example.com',password,username:'SAME',code:f.code()};
 const result=await Promise.allSettled([f.store.register(third,'p1'),f.store.register(fourth,'p2')]);assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(f.db.prepare('SELECT count(*) n FROM workspace_accounts').get().n,3);
});
test('reset purpose isolation, expiry, lockout, replay, session revocation and stale login issuance',async t=>{
 const f=fixture(t),a=await f.register('alpha@example.com','alpha'),b=await f.register('beta@example.com','beta'),token1=f.store.issue(a),token2=f.store.issue(a),other=f.store.issue(b);
 await f.store.sendCode('new@example.com','new',f.sender);await assert.rejects(f.store.resetPassword({email:'alpha@example.com',password:updated,code:f.code()},'wrong-purpose'),/验证码/);
 f.tick();await f.store.sendResetCode(a.email,'reset',f.sender);const resetCode=f.code();
 await assert.rejects(f.store.register({email:'new@example.com',password,code:resetCode},'cross'),/验证码/);
 for(let i=0;i<5;i++)await assert.rejects(f.store.resetPassword({email:a.email,password:updated,code:resetCode==='000000'?'000001':'000000'},'fail'+i),/验证码/);
 await assert.rejects(f.store.resetPassword({email:a.email,password:updated,code:resetCode},'locked'),/验证码/);assert.ok(f.store.session(token1));
 f.tick();await f.store.sendResetCode(a.email,'expire',f.sender);f.tick(300001);await assert.rejects(f.store.resetPassword({email:a.email,password:updated,code:f.code()},'expired'),/验证码/);
 f.tick();await f.store.sendResetCode(a.email,'fresh',f.sender);const valid=f.code();
 const pendingLogin=await f.store.login('alpha',password,'before-reset');
 assert.deepEqual(await f.store.resetPassword({email:a.email,password:updated,code:valid},'success'),{ok:true});
 assert.equal(f.store.session(token1),null);assert.equal(f.store.session(token2),null);assert.ok(f.store.session(other));assert.throws(()=>f.store.issue(pendingLogin),/密码已更新/);
 await assert.rejects(f.store.login('alpha',password,'old-password'),/账号或密码/);assert.ok(f.store.issue(await f.store.login('alpha',updated,'new-password')));
 await assert.rejects(f.store.resetPassword({email:a.email,password,code:valid},'replay'),/验证码/);
 assert.equal(f.db.prepare('SELECT count(*) n FROM account_reset_codes').get().n,0);
 const before=f.mail.length;f.tick();assert.deepEqual(await f.store.sendResetCode('absent@example.com','unknown',f.sender),{ok:true,retryAfter:60});assert.equal(f.mail.length,before);
 await assert.rejects(f.store.sendResetCode('absent@example.com','unknown',f.sender),/次数/);
});
test('old accounts migrate additively; reset/name routes enforce authentication and restart preserves recovery semantics',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-account-recovery-'));let repository,server,url;const mail=[];
 function start(){
  repository=new WorkspaceRepository({dataDir:dir});const connection=initialConnection(repository,{dataDir:dir,port:5490,scope:{projectId:'legacy',versionId:null,branchId:null}}),rootAuth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8'));
  const localProjects=new LocalProjects({repository,dataDir:dir,connection,rootAuth}),accounts=createAccounts({repository,dataDir:dir,localProjects,mailer:{ready:()=>true,send:async message=>mail.push(message)}});
  server=createWorkspaceServer({repository,localProjects,accounts});
 }
 t.after(async()=>{await server?.close();repository?.close();rmSync(dir,{recursive:true,force:true});});start();url=await server.listen();
 const post=async(action,body,cookie='')=>{const response=await fetch(url+'/api/v1/auth/'+action,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 await post('send-code',{email:'legacy@example.com'});const a=await post('register',{email:'legacy@example.com',password,code:mail.at(-1).text.match(/\d{6}/)[0]});assert.equal(a.status,201);assert.equal(a.body.account.username,null);
 assert.equal((await post('set-name',{username:'legacy'})).status,403);
 const changed=await post('set-name',{username:'legacy'},a.cookie);assert.equal(changed.status,200);assert.equal(changed.body.account.username,'legacy');
 assert.equal((await post('login',{identifier:'LEGACY',password})).status,200);
 assert.equal((await post('login',{email:'legacy@example.com',identifier:'legacy',password})).status,400);
 assert.equal((await post('reset-password',{email:'legacy@example.com',password:updated,code:'000000'})).status,400);
 assert.ok(requiredDataFeatures(join(dir,'workspace.sqlite')).includes('account-recovery/1'));
 const original=a.body.account.id;await server.close();repository.close();start();url=await server.listen();const login=await post('login',{identifier:'legacy',password});assert.equal(login.status,200);assert.equal(login.body.account.id,original);
 assert.equal(JSON.stringify(login.body).includes('password'),false);
});
