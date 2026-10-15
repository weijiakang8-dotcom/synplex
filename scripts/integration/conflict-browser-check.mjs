import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,rmSync,mkdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import * as context from '../../packages/context/index.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';

// Reuse an explicitly supplied, already installed browser driver; never install into another project.
const driver=process.env.SYNPLEX_BROWSER_DRIVER;
if(!driver)throw new Error('请提供已安装浏览器驱动的路径；本检查不会安装依赖。');
const {chromium}=await import(pathToFileURL(resolve(driver)).href);
const dataDir=mkdtempSync(join(tmpdir(),'synplex-conflict-ui-'));
const repository=new WorkspaceRepository({dataDir}),scope={projectId:'conflict-ui-fixture',versionId:null,branchId:null};
const human=repository.createCredential({ownerId:'fixture',actorId:'local-human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task','record_result']});
const host=repository.createCredential({ownerId:'fixture',actorId:'host',scope,capabilities:['read_memory','prepare_task']});
const uiTokenFile=join(dataDir,'ui'),agentTokenFile=join(dataDir,'host');writeFileSync(uiTokenFile,human.token,{mode:0o600});writeFileSync(agentTokenFile,host.token,{mode:0o600});
const auth=repository.authenticate(human.token),repo=await repository.forScope(auth,scope);
const meta=()=>({requestId:randomUUID(),expectedStateRevision:repository.state(auth,scope).stateRevision});
const material=(text,eventId)=>({bytes:Buffer.from(text),format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:'fixture',eventId,occurredAt:null,importOrigin:'isolated_test'});
const eventId=randomUUID();await ingestion.importSource(repo,material('房间20间。',eventId),meta());
await assert.rejects(ingestion.importSource(repo,material('房间22间，其中2间备用。',eventId),meta()));
const localProjects=new LocalProjects({repository,dataDir,connection:{scope,uiTokenFile,agentTokenFile},rootAuth:auth});
const app=createWorkspaceServer({repository,modules:{context,ingestion},localProjects,publicDir:resolve('public')});
const url=await app.listen(),browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
const errors=[];
try{
 const page=await browser.newPage({viewport:{width:390,height:844}});page.setDefaultTimeout(10000);page.on('pageerror',e=>errors.push(e.message));
 const pair=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pair.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('[data-nav="review"]').first().click();
 const form=page.locator('.conflict-form');await form.locator('select[name="action"]').selectOption('merge');
 await form.locator('input[name="title"]').fill('可售房间');await form.locator('textarea[name="body"]').fill('可售20间，备用2间。');
 await form.locator('textarea[name="note"]').fill('逐间核对后的结论。');await form.locator('input[name="supersedes"]').first().check();
 await page.locator('nav [data-nav="history"]').click();await page.locator('[data-nav="review"]').first().click();
 assert.equal(await form.locator('textarea[name="body"]').inputValue(),'可售20间，备用2间。','切页不丢更正草稿');
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'手机无横向溢出');
 await form.locator('button.primary').click();await form.waitFor({state:'detached'});
 const state=repository.state(auth,scope);assert.equal(state.conflicts.length,0);assert.ok(state.facts.some(c=>c.body==='可售20间，备用2间。'));
 assert.deepEqual(errors,[]);
 const out=resolve('.runtime/implementation-baseline');mkdirSync(out,{recursive:true});
 await page.screenshot({path:join(out,'conflict-correction.png'),fullPage:true});
 writeFileSync(join(out,'conflict-browser.json'),JSON.stringify({checks:['390px layout','draft survives switching','UI to HTTP to SQLite correction','new sourced fact','no page errors'],errors,modelCalls:0},null,2));
 process.stdout.write('冲突更正页面端到端检查通过，模型调用0。\n');
}finally{await browser.close();await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});}
