import {previewSourceFixture} from '../../scripts/testing/source-preview-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {performance} from 'node:perf_hooks';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,meta} from './helpers.mjs';
import {SOURCE_PREVIEW_BYTES} from '../../services/workspace/source-preview.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';


test('资料预览有界逐段读完，提问只取身份；原文、游标版本与权限不降级',async t=>{
 const h=await setup(t),fixture=await previewSourceFixture(h.repo),app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());
 const pair=await app.createUiPairing(h.auth,h.repo.scope),login=await fetch(url+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:pair.nonce}),redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const post=(extra={})=>fetch(url+'/api/v1/ui_source_preview',{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:h.repo.scope,sourceId:fixture.source.id,...extra})});
 const before=await h.repo.getState(),summary=await (await post({mode:'summary'})).json();
 assert.equal(summary.blockCount,fixture.texts.length);assert.equal(summary.occurrenceId,fixture.event.id);assert.deepEqual(summary.parsed.blocks,[]);assert.ok(JSON.stringify(summary).length<5000);
 const reconstructed=[],latencies=[];let cursor=null,first=null,pages=0;
 do{
  const started=performance.now(),response=await post({cursor});assert.equal(response.status,200);const page=await response.json();latencies.push(performance.now()-started);
  if(!first)first=page;
  assert.ok(page.page.displayBytes<=SOURCE_PREVIEW_BYTES);assert.ok(page.parsed.blocks.length<=40);assert.ok(JSON.stringify(page).length<90000);
  for(const block of page.parsed.blocks){assert.ok(!block.text.includes('\ufffd'));reconstructed.push(block.text);}
  cursor=page.page.cursor;pages++;assert.ok(pages<30);
 }while(cursor);
 assert.equal(reconstructed.join(''),fixture.texts.join(''));assert.ok(pages>2);assert.ok(first.page.cursor);
 assert.equal((await post({cursor:first.page.cursor,sourceId:'missing'})).status,403);
 assert.equal((await post({cursor:first.page.cursor,scope:{...h.repo.scope,projectId:'foreign'}})).status,403);
 assert.equal((await post({mode:'invented'})).status,403);assert.equal((await post({surprise:true})).status,403);
 assert.deepEqual(await h.repo.getState(),before);assert.deepEqual(Buffer.from((await h.repo.getBlob(fixture.source.id)).bytes),fixture.bytes);
 assert.deepEqual(h.repository.read(h.auth,h.repo.scope,'parsed',fixture.parsed.id),fixture.parsed);
 const {id,recordedAt,...newParse}=fixture.parsed;
 await h.repo.appendParsedRevisions([{...newParse,parserVersion:'preview-fixture/2'}],await meta(h.repo));
 assert.equal((await post({cursor:first.page.cursor})).status,409,'new revision must not splice into the old preview');
 const corrupt=new DatabaseSync(join(h.dataDir,'workspace.sqlite'));
 corrupt.prepare('UPDATE raw_blobs SET bytes=? WHERE sha256=?').run(Buffer.alloc(fixture.bytes.length),fixture.source.sha256);
 assert.equal((await post({mode:'summary'})).status,409,'identity-only reads must still detect corrupt originals');corrupt.close();
 h.repository.revokeCredential(h.credential.id);assert.equal((await post({cursor:first.page.cursor})).status,403);
 t.diagnostic(JSON.stringify({pages,sourceBytes:fixture.bytes.length,largestAllowedDisplayBytes:SOURCE_PREVIEW_BYTES,maximumHttpMs:Math.max(...latencies),modelCalls:0}));
});
