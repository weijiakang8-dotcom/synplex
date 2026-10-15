import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {PAGE_NAMES} from '../../public/workspace-pages.js';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as context from '../../packages/context/index.mjs';
import * as experience from '../../packages/experience/index.mjs';

const evidence=browserEvidenceDirectory('page-finder','SYNPLEX_PAGE_FINDER_EVIDENCE_DIR');
const dataDir=mkdtempSync(join(tmpdir(),'synplex-page-finder-')),repository=new WorkspaceRepository({dataDir}),scope={projectId:'page-finder-a',versionId:null,branchId:null};
const human=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result']});
const host=repository.createCredential({ownerId:'fixture',actorId:'host',scope,kind:'agent',capabilities:['read_memory','write_memory','prepare_task','record_result']});
const auth=repository.authenticate(human.token),connection={scope,uiTokenFile:join(dataDir,'ui-token'),agentTokenFile:join(dataDir,'agent-token')};
writeFileSync(connection.uiTokenFile,human.token,{mode:0o600});writeFileSync(connection.agentTokenFile,host.token,{mode:0o600});
const localProjects=new LocalProjects({repository,dataDir,connection,rootAuth:auth}),other=await localProjects.create(auth,{requestId:'page-finder-b',name:'第二个项目'});
const app=createWorkspaceServer({repository,localProjects,modules:{ingestion,context,experience},publicDir:resolve('public')}),url=await app.listen(),browser=await launchTestBrowser();
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],external=[],writes=[];
 page.on('pageerror',error=>errors.push(error.message));
 await page.route('**/*',route=>{const request=route.request(),target=new URL(request.url());if(target.origin!==url){external.push(target.origin);return route.abort();}if(request.method()==='POST')writes.push(target.pathname);return route.continue();});
 const pairing=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pairing.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('#project-select').waitFor();
 const active=()=>page.locator('[role=tab][aria-selected=true]').getAttribute('data-id');
 const open=async()=>{await page.locator('.page-menu summary').click();await page.locator('[data-action=find-page]').click();await page.locator('#page-finder-form').waitFor();};
 const navigate=async text=>{await open();await page.locator('#page-finder-form input').fill(text);await page.locator('#page-finder-form').getByRole('button',{name:'打开',exact:true}).click();};
 for(const [id,name] of Object.entries(PAGE_NAMES)){await navigate('请帮我打开'+name+'页面。');assert.equal(await active(),id);}
 await navigate('打开资料');await page.locator('[name=material]').fill('尚未上传的资料草稿');
 await page.locator('[name=source]').setInputFiles({name:'尚未上传.md',mimeType:'text/markdown',buffer:Buffer.from('原始内容未上传')});
 await navigate('切换到任务');await page.locator('[name=goal]').fill('打开资料并删除原文件');await page.locator('[name=acceptance]').fill('这仍是任务要求，尚未提交');
 await page.keyboard.press('Control+k');await page.locator('#page-finder-form').waitFor();
 const input=page.locator('#page-finder-form input');await input.fill('打开资料并删除原文件');
 await page.locator('#page-finder-form').getByRole('button',{name:'打开',exact:true}).click();
 assert.match(await page.locator('dialog [role=status]').innerText(),/没有这个页面/);assert.equal(await active(),'task');
 await page.keyboard.press('Meta+k');assert.equal(await input.inputValue(),'打开资料并删除原文件','快捷键不覆盖任何已打开弹窗');
 await input.fill('查看成果');
 await input.dispatchEvent('compositionstart');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',keyCode:229,isComposing:true,bubbles:true});
 await page.locator('#page-finder-form').evaluate(form=>form.requestSubmit());
 assert.equal(await page.locator('dialog').evaluate(element=>element.open),true);assert.equal(await active(),'task');
 await input.dispatchEvent('compositionend');await input.dispatchEvent('keyup',{key:'Enter',code:'Enter',isComposing:false,bubbles:true});
 await page.locator('#page-finder-form').getByRole('button',{name:'打开',exact:true}).click();assert.equal(await active(),'results');
 await open();await page.locator('[data-action=open-found-page][data-id=materials]').click();assert.equal(await active(),'materials');assert.equal(await page.locator('[name=material]').inputValue(),'尚未上传的资料草稿');assert.equal(await page.locator('[name=source]').evaluate(input=>input.files[0].name),'尚未上传.md');
 await open();await page.screenshot({path:join(evidence,'查找页面-手机.png'),fullPage:true});
 const semantics=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');return {operations:availableOperations(),ambiguous:[...document.querySelectorAll('[data-ai-state=ambiguous]')].map(element=>element.dataset.aiId)};});
 assert.deepEqual(semantics.ambiguous,[]);assert.equal(semantics.operations.filter(x=>x.action==='open-found-page').length,8);
 assert.ok(semantics.operations.every(x=>x.id.includes('page-finder')));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await input.fill('成果');await page.keyboard.press('Escape');assert.equal(await active(),'materials');
 await navigate('任务');assert.equal(await page.locator('[name=goal]').inputValue(),'打开资料并删除原文件');assert.equal(await page.locator('[name=acceptance]').inputValue(),'这仍是任务要求，尚未提交');
 // Delay the real existing project switch to exercise the app's save guard.
 let admitted,release;const admission=new Promise(resolve=>admitted=resolve),resume=new Promise(resolve=>release=resolve);
 await page.route(url+'/api/v1/ui_select_project',async route=>{const response=await route.fetch();admitted();await resume;await route.fulfill({response});});
 await page.locator('#project-select').selectOption(other.scope.projectId);await admission;
 await page.keyboard.press('Control+k');assert.equal(await page.locator('dialog').evaluate(element=>element.open),false);release();
 await page.waitForFunction(()=>document.querySelector('h1')?.textContent==='第二个项目');await navigate('任务');assert.equal(await page.locator('[name=goal]').inputValue(),'');
 assert.equal(repository.list(auth,scope,'source').length,0);assert.equal(repository.list(auth,scope,'run').length,0);assert.equal(repository.list(auth,scope,'attempt').length,0);
 assert.equal(repository.list(other.auth,other.scope,'run').length,0);
 assert.ok(writes.every(path=>['/api/v1/ui_history','/api/v1/ui_select_project'].includes(path)),JSON.stringify(writes));
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['eight existing pages via explicit Chinese names','mobile menu and Control/Meta shortcut entry','unsupported compound instruction does nothing; task text is never intercepted','modal and real pending project selection cannot be overwritten','composition protocol prevents Enter navigation; normal click works afterwards','task/material draft and original file selection survive; other project does not inherit draft','eight unambiguous available modal operations; Escape cancels; no mobile overflow','no source import, task creation, execution, external request or page error'],modelCalls:0,taskExecutions:0,nativeImeVerified:false,arbitraryNaturalLanguageVerified:false},null,2),{flag:'wx',mode:0o600});
 console.log('既有页面明确指令跳转、草稿/弹窗/输入法协议保护通过，模型调用0。');
}catch(error){writeFileSync(join(evidence,'failure.json'),JSON.stringify({error:String(error),modelCalls:0},null,2),{flag:'wx',mode:0o600});throw error;}
finally{await browser.close();await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});}
