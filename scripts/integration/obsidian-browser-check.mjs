import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,mkdirSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import * as context from '../../packages/context/index.mjs';
import {launchTestBrowser,browserEvidenceDirectory} from '../testing/browser.mjs';
import {noteLinks,resolveNoteLink,noteIdentity} from '../../public/obsidian-notes.js';
const evidence=browserEvidenceDirectory('obsidian','SYNPLEX_OBSIDIAN_EVIDENCE_DIR');
const dir=mkdtempSync(join(tmpdir(),'synplex-obsidian-')),vault=join(dir,'项目笔记');mkdirSync(vault);mkdirSync(join(vault,'阶段'));mkdirSync(join(vault,'.obsidian'));
const originals={'起点.md':'# 起点\r\n\r\n决定：先做本机版本，因为预算有限。\r\n\r\n[[阶段/转折#结论|为什么转向]]\r\n[下一步](阶段/转折.md#结论)\r\n[[尚未导入]]\r\n[[javascript:alert(1)]]\r\n', '阶段/转折.md':'# 转折\n\n失败：每次复制全部记录太长，容易漏掉关键决定。\n\n决定：改为筛选相关背景，保留出处。\n\n## 结论\n经验：换工具时先确认原任务状态，再继续。\n', '不选择.md':'这是私人笔记，不应上传。','.obsidian/设置.md':'设置不应上传。'};
for(const [path,text]of Object.entries(originals))writeFileSync(join(vault,path),text);
assert.throws(()=>noteIdentity('库','../逃逸.md'));
assert.equal(noteLinks('```md\n[[不是链接]]\n```\n[[真实|别名]]').length,1);
assert.equal(resolveNoteLink({vault:'库',path:'A.md'},{target:'同名',wiki:true},[{vault:'库',path:'一/同名.md'},{vault:'库',path:'二/同名.md'}]).status,'ambiguous');
const repository=new WorkspaceRepository({dataDir:join(dir,'data')}),scope={projectId:'vault-fixture',versionId:null,branchId:null};
const credential=repository.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory','write_memory','review_memory','prepare_task']}),auth=repository.authenticate(credential.token);
const app=createWorkspaceServer({repository,modules:{ingestion,context},publicDir:resolve('public')}),url=await app.listen(),browser=await launchTestBrowser();let page;
try{
 page=await browser.newPage({viewport:{width:1280,height:900}});const errors=[],uploads=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',r=>{if(r.url().endsWith('/import_source'))uploads.push(r.url());});
 const pairing=await app.createUiPairing(auth,scope);assert.equal((await page.request.post(url+'/api/v1/ui_pair',{form:{pair:pairing.nonce},maxRedirects:0})).status(),303);
 let lost=false;await page.route('**/api/v1/import_source',async route=>{
  if(!lost){lost=true;await route.fetch();await app.service.idle();await route.abort('failed');}
  else await route.continue();
 });
 await page.goto(url);await page.locator('nav [data-nav=materials]').click();await page.locator('[data-ai-id=import-obsidian]').click();const dialog=page.locator('#dialog');await dialog.locator('#vault-folder').setInputFiles(vault);
 assert.equal(await dialog.locator('[name=vault-note]').count(),3);assert.match(await dialog.locator('#vault-status').innerText(),/未列入/);
 for(const path of ['起点.md','阶段/转折.md'])await dialog.getByLabel(path,{exact:false}).check();
 await dialog.locator('#vault-import').click();await dialog.locator('#vault-error').filter({hasText:/\S/}).waitFor();
 assert.equal(repository.recordCount(auth,scope,'source'),1,'lost reply still saved the original once');
 await dialog.locator('#vault-import').click();await dialog.locator('#vault-status').filter({hasText:'已保存 2 篇'}).waitFor();await app.service.idle();assert.equal(uploads.length,3);
 const index=repository.obsidianNotes(auth,scope);assert.equal(index.items.length,2);assert.equal(index.complete,true);const before=repository.recordCount(auth,scope,'claim');
 await dialog.locator('#vault-import').click();await dialog.locator('#vault-status').filter({hasText:'未变化 2 篇'}).waitFor();assert.equal(uploads.length,3);assert.equal(repository.recordCount(auth,scope,'claim'),before);
 await dialog.locator('#close-dialog').click();const source=index.items.find(n=>n.path==='起点.md');await page.locator(`[data-action=preview-source][data-id="${source.sourceId}"]`).click();await dialog.getByRole('button',{name:'为什么转向',exact:true}).waitFor();assert.match(await dialog.innerText(),/尚未导入，可从笔记库补充/);assert.equal(await dialog.locator('button').filter({hasText:'javascript'}).count(),0);
 await dialog.getByRole('button',{name:'为什么转向',exact:true}).click();await dialog.locator('#source-preview-content').filter({hasText:'复制全部记录'}).waitFor();assert.match(await dialog.innerText(),/目标位置：结论/);
 await page.screenshot({path:join(evidence,'双链跳转-桌面.png'),fullPage:true});
 const other={...scope,projectId:'another-project'};await repository.forScope(auth,other).then(()=>assert.fail('cross project must deny'),()=>{});
 for(const note of index.items){const scoped=await repository.forScope(auth,scope),actual=await scoped.getBlob(note.sourceId);assert.deepEqual(Buffer.from(actual.bytes),readFileSync(join(vault,note.path)));}
 for(const [path,text]of Object.entries(originals))assert.equal(readFileSync(join(vault,path),'utf8'),text);
 const lockMeta={protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'lock-note',expectedStateRevision:repository.state(auth,scope).stateRevision,sourceId:source.sourceId,expectedMetadataRevision:0,metadata:{title:'起点',category:'项目经历',tags:[],locked:true}};
 repository.updateSourceMetadata(auth,lockMeta);
 const changed={protocolVersion:'synplex.workspace/1.0.0',scope,requestId:'changed-locked-note',expectedStateRevision:repository.state(auth,scope).stateRevision,format:'text/markdown',sourceSystem:'obsidian-markdown',formatVersion:'1',sessionId:JSON.stringify(noteIdentity('项目笔记','起点.md')),eventId:'locked-update',occurredAt:null};
 assert.throws(()=>repository.admitImport(auth,changed,Buffer.from('# 起点\n决定：删除原记录。')),e=>e.code==='conflict');
 assert.equal(repository.obsidianNotes(auth,scope).items.find(n=>n.sourceId===source.sourceId).locked,true);
 const scoped=await repository.forScope(auth,scope),locked=await ingestion.importSource(scoped,{bytes:readFileSync(join(vault,'起点.md')),format:'text/markdown',sourceSystem:'obsidian-markdown',formatVersion:'1',sessionId:changed.sessionId,eventId:'locked-original',occurredAt:null,importOrigin:'user_upload'},{requestId:'locked-original',expectedStateRevision:(await scoped.getState()).stateRevision});
 assert.ok(locked.warnings.some(w=>w.code==='conflict'),'automatic candidate extraction respects source lock');assert.equal(repository.recordCount(auth,scope,'claim'),before);
 assert.equal(repository.recordCount(auth,scope,'source'),2);assert.equal(repository.recordCount(auth,scope,'attempt'),0);
 await dialog.locator('#close-dialog').click();await page.setViewportSize({width:390,height:844});await page.locator('[data-ai-id=import-obsidian]').click();await dialog.locator('#vault-files').setInputFiles(join(vault,'起点.md'));assert.equal(await dialog.locator('[name=vault-note]').count(),1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 assert.deepEqual(await page.evaluate(async()=>{const {availableOperations}=await import('/semantic-actions.js');availableOperations();return [...document.querySelectorAll('[data-ai-state=ambiguous]')].map(e=>e.dataset.aiId);}),[]);
 await page.screenshot({path:join(evidence,'选择笔记-手机.png'),fullPage:true});assert.deepEqual(errors,[]);
 writeFileSync(join(evidence,'result.json'),JSON.stringify({checks:['actual folder picker selection and exact CRLF original bytes','only selected notes uploaded; hidden settings excluded','lost reply reconciles original request without duplicate records; unchanged import skips','wikilink alias and markdown relative link retained; target and missing explained','code fences, dangerous protocols, duplicate basename handling','changed locked note rejected server-side; candidate lock respected','project isolation and stable semantic controls; mobile overflow','source vault unchanged'],uploads:uploads.length,modelCalls:0},null,2));console.log('笔记选择、精确原文、双链、丢失回执续接、编辑锁和项目边界浏览器验收通过；模型调用0。');
}catch(error){writeFileSync(join(evidence,'failure.json'),JSON.stringify({message:error.message,stack:error.stack}));if(page)await page.screenshot({path:join(evidence,'failure.png'),fullPage:true}).catch(()=>{});throw error;}
finally{await browser.close();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
