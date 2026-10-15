import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {createDiagnosticLog} from '../../services/workspace/diagnostics.mjs';

const {chromium}=await import(pathToFileURL(resolve(process.env.SYNPLEX_BROWSER_DRIVER)).href);
const evidence=resolve(process.env.SYNPLEX_DIAGNOSTIC_BROWSER_EVIDENCE_DIR??'.runtime/implementation-baseline/diagnostics-browser-r1');mkdirSync(evidence,{recursive:true,mode:0o700});
const dataDir=mkdtempSync(join(tmpdir(),'synplex-diagnostic-ui-')),repository=new WorkspaceRepository({dataDir}),scope={projectId:'diagnostics-ui',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result']}),auth=repository.authenticate(credential.token),diagnostics=createDiagnosticLog(dataDir);
// Deliberately leave the context module unavailable: a real backend refusal,
// not a fabricated successful task or a paid model failure.
const app=createWorkspaceServer({repository,diagnostics,publicDir:resolve('public')}),url=await app.listen();
const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
try{
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[],external=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('**/*',route=>{if(new URL(route.request().url()).origin===url)return route.continue();external.push(route.request().url());return route.abort();});
 const pairing=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pairing.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('nav [data-nav=task]').click();await page.locator('[name=goal]').fill('不可进入日志的项目需求');await page.locator('[name=acceptance]').fill('保留原始需求');
 const responsePromise=page.waitForResponse(r=>r.url().endsWith('/api/v1/prepare_task'));await page.locator('#task-form button.primary').click();const response=await responsePromise;assert.equal(response.status(),503);
 const trace=await response.headerValue('X-Synplex-Trace-Id');await page.waitForFunction(id=>document.querySelector('#toast')?.textContent.includes(id),trace);
 assert.match(await page.locator('#toast').innerText(),/问题编号/);assert.equal(await page.locator('[name=goal]').inputValue(),'不可进入日志的项目需求');
 const log=readFileSync(join(dataDir,'diagnostics/requests.jsonl'),'utf8'),record=log.trim().split('\n').map(JSON.parse).find(e=>e.traceId===trace);
 assert.equal(record.errorCode,'capability_unavailable');assert.equal(record.route,'prepare_task');assert.equal(record.status,503);assert.ok(!log.includes('不可进入日志的项目需求'));
 const panel=page.locator('[data-ai-context=task-status]');await panel.locator('summary').click();assert.match(await panel.innerText(),/这里只统计从工作台开始的任务/);assert.match(await panel.innerText(),/执行结束后，仍需检查成果/);
 const target=join(dataDir,'untouched-file');writeFileSync(target,'must remain unchanged',{mode:0o600});rmSync(join(dataDir,'diagnostics/requests.jsonl'));symlinkSync(target,join(dataDir,'diagnostics/requests.jsonl'));
 diagnostics.write(record);assert.equal(diagnostics.status().available,false);await page.locator('[data-action=refresh][data-ai-key=task-status]').click();await page.waitForFunction(()=>document.querySelector('#app').getAttribute('aria-busy')==='false'&&document.querySelector('[data-ai-context=task-status] .notice'));
 await panel.locator('summary').click();assert.match(await panel.innerText(),/诊断记录暂时无法保存/);assert.equal(readFileSync(target,'utf8'),'must remain unchanged');
 const operations=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');return {actions:availableOperations(),ambiguous:[...document.querySelectorAll('[data-ai-state=ambiguous]')].map(x=>x.dataset.aiId)};});assert.deepEqual(operations.ambiguous,[]);assert.ok(operations.actions.some(x=>x.action==='refresh'));
 assert.equal(repository.list(auth,scope,'attempt').length,0);assert.equal(repository.list(auth,scope,'run').length,0);assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await page.screenshot({path:join(evidence,'任务状态与问题编号-手机.png'),fullPage:true});writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['real HTTP unavailable response maps visible problem ID to private log','draft preserved after refusal; no attempt created','scoped status explanation and refresh','unsafe log path degrades visibly without writing external file','unambiguous actions and 390px no overflow or page error'],modelCalls:0},null,2));
 process.stdout.write('真实后端失败的问题编号、日志定位、草稿及诊断故障提示通过浏览器验收，模型调用0。\n');
}finally{await browser.close();await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});}
