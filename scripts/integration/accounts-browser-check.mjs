import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {createAccounts} from '../../services/workspace/accounts.mjs';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';
import * as context from '../../packages/context/index.mjs';
const output=browserEvidenceDirectory('accounts','SYNPLEX_ACCOUNT_EVIDENCE_DIR'),dir=mkdtempSync(join(tmpdir(),'synplex-account-ui-')),repository=new WorkspaceRepository({dataDir:dir});
const scope={projectId:'private-original',versionId:null,branchId:null},connection=initialConnection(repository,{dataDir:dir,scope,port:5447}),rootAuth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8'));
let time=Date.now();repository.accounts({clock:()=>time});
const projects=new LocalProjects({repository,dataDir:dir,connection,rootAuth}),mail=[],accounts=createAccounts({repository,dataDir:dir,localProjects:projects,mailer:{ready:()=>true,send:async message=>mail.push(message)}});
const server=createWorkspaceServer({repository,localProjects:projects,accounts,modules:{context},publicDir:resolve('public'),publicLanding:true,modelAdmin:auth=>accounts.admin(auth)}),url=await server.listen(),browser=await launchTestBrowser();
const errors=[],writes=[];
try{
 const c=await browser.newContext(),page=await c.newPage();
 await c.route('**/*',route=>{const request=route.request();assert.equal(new URL(request.url()).origin,url);if(request.method()==='POST')writes.push(new URL(request.url()).pathname);return route.continue();});
 page.on('pageerror',error=>errors.push(error.message));
 await page.goto(url+'/app');await page.getByRole('heading',{name:'登录 Synplex',exact:true}).waitFor();assert.equal(await page.locator('[name=pair]').count(),0);assert.equal(new URL(page.url()).pathname,'/login');
 await page.locator('[data-auth-forgot]').click();await page.getByRole('heading',{name:'找回密码',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/forgot-password');
 await page.reload();await page.getByRole('heading',{name:'找回密码',exact:true}).waitFor();assert.equal(await page.locator('[name=username]').count(),0);
 await page.getByRole('link',{name:'还没有账号？先注册'}).click();await page.getByRole('heading',{name:'注册 Synplex',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/register');
 await page.reload();await page.getByRole('heading',{name:'注册 Synplex',exact:true}).waitFor();await page.goBack();await page.getByRole('heading',{name:'找回密码',exact:true}).waitFor();await page.goForward();await page.getByRole('heading',{name:'注册 Synplex',exact:true}).waitFor();
 await page.locator('[data-auth-switch]').click();await page.getByRole('heading',{name:'登录 Synplex',exact:true}).waitFor();
 async function register(email){
  await page.locator('[data-auth-switch]').click();await page.getByRole('heading',{name:'注册 Synplex',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/register');await page.locator('[name=username]').fill(email.split('@')[0]+'user');await page.locator('[name=email]').fill(email);await page.locator('[name=password]').fill('synthetic-password');await page.locator('[name=confirm]').fill('different-password');await page.locator('[data-auth-send]').click();await page.locator('[data-auth-message]').filter({hasText:'验证码已发送'}).waitFor();
  assert.equal(await page.locator('[data-auth-send]').isDisabled(),true);await page.locator('[name=code]').fill(mail.at(-1).text.match(/\d{6}/)[0]);
  await page.locator('[data-auth-form] [type=submit]').click();await page.locator('[data-auth-message]').filter({hasText:'两次输入的密码不一致'}).waitFor();
  await page.locator('[name=confirm]').fill('synthetic-password');await page.locator('[data-auth-form] [type=submit]').click();await page.locator('#workspace-main').waitFor();
 }
 await register('first@example.com');await page.locator('#workspace-navigation [data-nav=task]').click();await page.locator('[name=goal]').fill('只属于第一个账号的未提交草稿');
 const alpha=await page.evaluate(()=>fetch('/api/v1/ui_bootstrap').then(r=>r.json()));
 await page.reload();await page.locator('#workspace-main').waitFor();await page.locator('#workspace-navigation [data-nav=task]').click();assert.equal(await page.locator('[name=goal]').inputValue(),'只属于第一个账号的未提交草稿');
 const parallel=await c.newPage();await parallel.goto(url+'/app');await parallel.locator('#workspace-main').waitFor();
 await page.locator('[data-action=logout]').click();await page.getByRole('heading',{name:'登录 Synplex',exact:true}).waitFor();await parallel.getByRole('heading',{name:'登录 Synplex',exact:true}).waitFor();
 await register('second@example.com');await page.locator('#workspace-navigation [data-nav=task]').click();assert.equal(await page.locator('[name=goal]').inputValue(),'');
 const denied=await page.evaluate(async scope=>{const response=await fetch('/api/v1/ui_history',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope})});return response.status;},alpha.scope);assert.equal(denied,403);
 await page.locator('[data-action=logout]').click();await page.locator('[data-auth-form]').waitFor();await page.locator('[name=email]').fill('first@example.com');await page.locator('[name=password]').fill('synthetic-password');await page.locator('[data-auth-form] [type=submit]').click();await page.locator('#workspace-main').waitFor();await page.locator('#workspace-navigation [data-nav=task]').click();assert.equal(await page.locator('[name=goal]').inputValue(),'只属于第一个账号的未提交草稿');
 await page.locator('[data-account-settings]').click();await page.getByRole('heading',{name:'账号设置',exact:true}).waitFor();await page.locator('#dialog [name=username]').fill('FirstChanged');await page.locator('#dialog [type=submit]').click();await page.locator('#dialog [role=alert]').filter({hasText:'登录名已保存'}).waitFor();await page.locator('[data-account-close]').click();
 await page.reload();await page.locator('#workspace-main').waitFor();assert.ok((await page.locator('#workspace-navigation').innerText()).includes('firstchanged'));
 await page.screenshot({path:join(output,'账号登录后的工作台.png'),fullPage:true});
 // Real browser form -> production HTTP routes -> synthetic mailbox, no live mail.
 const staleCookies=await c.cookies();await page.goto(url+'/app?account=reset');await page.getByRole('heading',{name:'找回密码',exact:true}).waitFor();assert.equal(new URL(page.url()).pathname,'/forgot-password');
 time+=60001;await page.locator('[name=email]').fill('first@example.com');await page.locator('[data-auth-send]').click();await page.locator('[data-auth-message]').filter({hasText:'如果该邮箱已注册'}).waitFor();assert.ok(mail.at(-1).subject.includes('重置密码'));
 await page.locator('[name=code]').fill(mail.at(-1).text.match(/\d{6}/)[0]);await page.locator('[name=password]').fill('changed-synthetic-password');await page.locator('[name=confirm]').fill('changed-synthetic-password');await page.locator('[data-auth-form] [type=submit]').click();await page.locator('[data-auth-message]').filter({hasText:'密码已重置'}).waitFor();
 await page.locator('[name=email]').fill('firstchanged');await page.locator('[name=password]').fill('synthetic-password');await page.locator('[data-auth-form] [type=submit]').click();await page.locator('[data-auth-message]').filter({hasText:'账号或密码不正确'}).waitFor();
 await page.locator('[name=password]').fill('changed-synthetic-password');await page.locator('[data-auth-form] [type=submit]').click();await page.locator('#workspace-main').waitFor();await page.locator('#workspace-navigation [data-nav=task]').click();assert.equal(await page.locator('[name=goal]').inputValue(),'只属于第一个账号的未提交草稿');
 const old=await browser.newContext();await old.addCookies(staleCookies);const oldPage=await old.newPage();await oldPage.goto(url+'/app');await oldPage.getByRole('heading',{name:'登录 Synplex',exact:true}).waitFor();await old.close();
 await page.locator('[data-action=logout]').click();await page.locator('[data-auth-form]').waitFor();await page.setViewportSize({width:390,height:844});await page.screenshot({path:join(output,'手机登录.png'),fullPage:true});
 assert.deepEqual(errors,[]);assert.ok(writes.every(path=>!['/api/v1/execute_task','/api/v1/ui_chat_send','/api/v1/ui_probe_model'].includes(path)));
 writeFileSync(join(output,'result.json'),JSON.stringify({modelCalls:0,realEmailDelivery:false,checks:['separate login/register/password recovery URLs, reload, back and forward, legacy bookmarks','email-code registration, countdown, password confirmation','password login, reload stays signed in','logout revokes current session and updates other tabs','two accounts cannot share UI drafts or read other project','returning account retains its own unsubmitted draft','login name registration and editing, email compatibility','password reset, old password rejected, new password login preserves draft','desktop and mobile login, no browser errors'],errors},null,2),{flag:'wx',mode:0o600});
 console.log('真实浏览器注册、登录、刷新、跨标签退出与账号草稿隔离通过；模型调用0，邮件为测试投递。');
}finally{await browser.close();await server.close();repository.close();rmSync(dir,{recursive:true,force:true});}
