import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {join} from 'node:path';
import {setup,input,meta,scope,errorIs} from './helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {PROTOCOL_VERSION,payloadHash,validateEvidence} from '../../packages/contracts/validate.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';

test('资料概览按真实版本分层、相关内容变更才失效，拒绝/改稿/损坏重建不复活旧结论或改变原件',async t=>{
 const h=await setup(t),app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());
 const post=async(body,token=h.credential.token)=>{const r=await fetch(url+'/api/v1/ui_source_brief',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:PROTOCOL_VERSION,scope,...body})});return {status:r.status,value:await r.json()};};
 const review=async(claim,status)=>{const r={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:claim.id,reviewStatus:status},grant=h.repository.issueReviewAuthorization(h.auth,r);return h.repository.review(h.auth,{...r,authorizationId:grant.authorizationId}).value;};
 const imported=await importSource(h.repo,input('决定：保留费用明细，不能把未知费用填零。🧪'+ '补充说明'.repeat(100)),await meta(h.repo)),old=(await h.repo.getState()).pending[0],stateBefore=await h.repo.getState(),operationsBefore=h.repository.list(h.auth,scope,'operation').length;
 const first=(await post({sourceId:imported.source.id})).value;assert.equal(first.cacheStatus,'rebuilt');assert.equal(first.counts.pending,1);assert.equal(first.complete,false);
 for(const e of first.excerpts)validateEvidence(e.evidence,imported.parsed.blocks.find(b=>b.id===e.evidence.blockId));
 assert.equal((await post({sourceId:imported.source.id})).value.cacheStatus,'hit');assert.deepEqual(await h.repo.getState(),stateBefore);assert.equal(h.repository.list(h.auth,scope,'operation').length,operationsBefore);
 await importSource(h.repo,input('决定：另一份资料只讲会议安排。'),await meta(h.repo));assert.equal((await post({sourceId:imported.source.id})).value.signature,first.signature,'无关资料不触发本资料重算');
 await review(old,'confirmed');let brief=(await post({sourceId:imported.source.id})).value;assert.equal(brief.cacheStatus,'rebuilt');assert.equal(brief.counts.confirmed,1);assert.equal(brief.counts.pending,0);
 const edited=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:old.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',old.id)),draft:{type:'decision',title:'费用核对',body:'保留费用明细，并标明账单出处。',condition:null},note:'保留证据，便于核对。'}).value;
 brief=(await post({sourceId:imported.source.id})).value;assert.equal(brief.counts.confirmed,1);assert.equal(brief.counts.pending,1,'新手工来源仍能沿版本关系回到原资料');
 await review(edited,'confirmed');brief=(await post({sourceId:imported.source.id})).value;assert.equal(brief.confirmed[0].id,edited.id);assert.equal(brief.counts.historical,1);assert.equal(brief.pending.length,0);
 await review(edited,'rejected');brief=(await post({sourceId:imported.source.id})).value;assert.equal(brief.confirmed.length,0);assert.equal(brief.counts.historical,2);assert.equal((await h.repo.getState()).decisions.some(c=>c.id===old.id),false);
 await review(edited,'confirmed');assert.equal((await post({sourceId:imported.source.id})).value.confirmed[0].id,edited.id,'保留本人重新核对当前记录的旧能力');
 const db=new DatabaseSync(join(h.dataDir,'workspace.sqlite'));db.exec("UPDATE source_briefs SET body_json='{broken'; DELETE FROM search_replacements; DELETE FROM search_index_state;");db.close();
 brief=(await post({sourceId:imported.source.id})).value;assert.equal(brief.cacheStatus,'rebuilt');assert.equal(brief.confirmed[0].id,edited.id);assert.equal(h.repository.getBlob(h.auth,scope,imported.source.id).blob.sha256,imported.source.sha256);
 assert.equal((await post({sourceId:imported.source.id,scope:{...scope,projectId:'other'}})).status,403);
 await h.reopen();assert.equal(h.repository.sourceBrief(h.auth,scope,imported.source.id).confirmed[0].id,edited.id);h.repository.revokeCredential(h.credential.id);assert.throws(()=>h.repository.sourceBrief(h.auth,scope,imported.source.id),errorIs('scope_denied'));
});
