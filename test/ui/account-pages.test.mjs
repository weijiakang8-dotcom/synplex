import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {ACCOUNT_PATHS,accountMode,isAccountPage} from '../../public/account-navigation.js';
import {accountForm} from '../../public/account-forms.js';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';

test('account page addresses, purpose labels and links stay separate, including legacy bookmarks',()=>{
 for(const [mode,path] of Object.entries(ACCOUNT_PATHS)){
  for(const suffix of ['','/']){
   const location=new URL('http://localhost'+path+suffix+'?account=register');
   assert.ok(isAccountPage(location));assert.equal(accountMode(location),mode);
  }
  const html=accountForm(mode,'person@example.com',{mailReady:true});
  assert.ok(html.includes(`data-account-mode="${mode}"`));assert.ok(html.includes('<nav aria-label="账号入口">'));
  assert.equal(html.includes('name="username"'),mode==='register');
  assert.equal(html.includes('获取注册验证码'),mode==='register');
  assert.equal(html.includes('获取重置验证码'),mode==='reset');
  assert.equal(html.includes('name="confirm"'),mode!=='login');
  if(mode==='login'){assert.ok(html.includes('href="/register"'));assert.ok(html.includes('href="/forgot-password"'));}
  if(mode==='reset'){assert.ok(html.includes('还没有账号？先注册'));assert.ok(html.includes('href="/login"'));}
 }
 assert.equal(accountMode(new URL('http://localhost/app?account=reset')),'reset');
 assert.equal(accountMode(new URL('http://localhost/app?account=register')),'register');
 assert.equal(isAccountPage(new URL('http://localhost/app')),false);
 assert.equal(isAccountPage(new URL('http://localhost/register-more')),false);
});

test('direct account page loads retain CSP and no-store while unpaired private API stays protected',async t=>{
 const dataDir=mkdtempSync(join(tmpdir(),'synplex-account-pages-')),repository=new WorkspaceRepository({dataDir});
 const server=createWorkspaceServer({repository,publicDir:resolve('public'),publicLanding:true});
 t.after(async()=>{await server.close();repository.close();rmSync(dataDir,{recursive:true,force:true});});
 const url=await server.listen();
 for(const path of Object.values(ACCOUNT_PATHS).flatMap(p=>[p,p+'/'])){
  const response=await fetch(url+path);assert.equal(response.status,200,path);
  assert.equal(response.headers.get('cache-control'),'no-store');assert.ok(response.headers.get('content-security-policy').includes("form-action 'self'"));
  assert.ok((await response.text()).includes('/app.js'));
 }
 assert.equal((await fetch(url+'/account-navigation.js')).status,200);
 assert.equal((await fetch(url+'/api/v1/ui_bootstrap')).status,403);
 assert.equal((await fetch(url+'/register-more')).status,403);
});
