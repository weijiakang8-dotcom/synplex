import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {importSource} from '../../packages/ingestion/index.mjs';
import {setup,input,meta,scope} from './helpers.mjs';

test('索引保留中文短词、字面符号、同源事件和核对语义；损坏投影重建不改原件，撤权生效',async t=>{
 const h=await setup(t),text='决定：中文的转向很重要。Keep %_ "quoted" evidence 😀。';
 const first=await importSource(h.repo,input(text),await meta(h.repo));
 await importSource(h.repo,input(text),await meta(h.repo));
 const query=(q,extra={})=>h.repo.queryEvidence({query:q,limit:1,cursor:null,includeHistory:true,occurrenceIds:null,...extra});
 for(const term of ['中','中文','中文的转','KEEP','%_','"quoted"','😀']){
  const page=await query(term);assert.equal(page.items.length,1,term);assert.ok(page.cursor);assert.ok(page.items[0].span.quote.toLocaleLowerCase().includes(term.toLocaleLowerCase()));
  const last=await query(term,{cursor:page.cursor});assert.equal(last.items.length,1);assert.equal(last.cursor,null);assert.notEqual(page.items[0].occurrence.id,last.items[0].occurrence.id);
 }
 const one=await query('中文',{occurrenceIds:[first.occurrences[0].id]});assert.equal(one.items.length,1);assert.equal(one.cursor,null);
 const claim=(await h.repo.getState()).pending[0],m=await meta(h.repo),request={protocolVersion:'synplex.workspace/1.0.0',scope,...m,claimId:claim.id,reviewStatus:'rejected'};
 const grant=h.repository.issueReviewAuthorization(h.auth,request);h.repository.review(h.auth,{...request,authorizationId:grant.authorizationId});
 const filtered=await query('中文',{includeHistory:false,limit:10});assert.equal(filtered.items.length,2);assert.equal(filtered.items.find(x=>x.occurrence.id===first.occurrences[0].id).claim,null);
 assert.ok((await query('中文',{includeHistory:true,limit:10})).items.some(x=>x.claim?.id===claim.id));
 // Simulate loss of only the derived index. Originals/claims stay immutable.
 h.repository.close();const db=new DatabaseSync(join(h.dataDir,'workspace.sqlite'));
 assert.equal(db.prepare('SELECT count(*) AS n FROM search_documents').get().n,1);assert.equal(db.prepare('SELECT count(*) AS n FROM search_occurrences').get().n,2);
 db.exec('DELETE FROM search_occurrences; DELETE FROM search_documents; DELETE FROM search_references; DELETE FROM search_index_state;');db.close();
 // h.reopen closes the repository first, so reopen explicitly after this closed handle.
 const {WorkspaceRepository}=await import('../../services/workspace/repository.mjs');h.repository=new WorkspaceRepository({dataDir:h.dataDir});h.auth=h.repository.authenticate(h.credential.token);h.repo=await h.repository.forScope(h.auth,scope);
 assert.equal((await query('中文',{limit:10})).items.length,2);assert.equal(Buffer.from((await h.repo.getBlob(first.source.id)).bytes).toString(),text);
 assert.equal(h.repository.recent(h.auth,scope,'occurrence',1).length,1);assert.equal(h.repository.recordCount(h.auth,scope,'occurrence'),2);
 h.repository.revokeCredential(h.credential.id);await assert.rejects(query('中文'),{code:'scope_denied'});
});
