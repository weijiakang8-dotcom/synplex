import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {sha256,PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';

const {chromium}=await import(pathToFileURL(resolve(process.env.SYNPLEX_BROWSER_DRIVER)).href);
const evidence=resolve(process.env.SYNPLEX_NOTE_BROWSER_EVIDENCE_DIR??'.runtime/implementation-baseline/note-export-browser-r1');mkdirSync(evidence,{mode:0o700});
const dir=mkdtempSync(join(tmpdir(),'synplex-note-export-ui-')),repository=new WorkspaceRepository({dataDir:dir}),scope={projectId:'note-export-ui',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory']}),auth=repository.authenticate(credential.token),repo=await repository.forScope(auth,scope);
const app=createWorkspaceServer({repository,publicDir:resolve('public')}),url=await app.listen(),browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true,args:['--disable-background-networking']});
try{
 const metadata=async()=>({requestId:randomUUID(),expectedStateRevision:(await repo.getState()).stateRevision});
 await importSource(repo,{bytes:Buffer.from('决定：保留调研原件，方便核对后续修改。'),format:'text/plain',sourceSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:'note-ui-fixture',occurredAt:null,importOrigin:'isolated_test'},await metadata());
 const claim=repository.list(auth,scope,'claim')[0],request={protocolVersion:PROTOCOL_VERSION,scope,...await metadata(),claimId:claim.id,reviewStatus:'confirmed'},grant=repository.issueReviewAuthorization(auth,request);repository.review(auth,{...request,authorizationId:grant.authorizationId});
 const page=await browser.newPage({viewport:{width:390,height:844}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.addInitScript(()=>Object.defineProperty(globalThis,'showSaveFilePicker',{value:undefined,configurable:true}));
 const pair=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pair.nonce},maxRedirects:0})).status(),303);
 await page.goto(url);await page.locator('nav [data-nav="history"]').click();await page.locator(`[data-action="source"][data-id="${claim.id}"]`).click();
 await page.locator('[data-action="preview-note-file"]').click();await page.locator('[data-action="save-note-file"]').waitFor();assert.match(await page.locator('#dialog').innerText(),/不会自动写入笔记库/);
 const actions=await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');return availableOperations();});assert.equal(actions.filter(a=>a.action==='save_note_file').length,1);
 const preview=await (await page.request.post(url+'/api/v1/ui_note_preview',{data:{protocolVersion:PROTOCOL_VERSION,scope,claimId:claim.id}})).json();
 const downloadPromise=page.waitForEvent('download');await page.locator('[data-action="save-note-file"]').click();const download=await downloadPromise;assert.equal(download.suggestedFilename(),preview.name);assert.equal(sha256(readFileSync(await download.path())),preview.sha256);
 assert.match(readFileSync(await download.path(),'utf8'),/原文依据/);assert.equal(repository.list(auth,scope,'attempt').length,0);
 await page.locator('#dialog details').evaluate(e=>e.open=true);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(errors,[]);
 await page.screenshot({path:join(evidence,'保存记录-手机.png'),fullPage:true});writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['confirmed record opens private preview','complete content and evidence','one unambiguous save action','real browser download matches selected version SHA','no attempt created','390px no overflow or page error'],nativePickerVerified:false,modelCalls:0},null,2));
 console.log('记录预览与真实浏览器文件下载通过，原文指纹一致，新增模型调用0；原生保存对话框尚未实测。');
}finally{await browser.close();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
