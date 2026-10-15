import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,input,meta,scope,errorIs} from './helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {recordJourney} from '../../services/workspace/record-journey.mjs';
import {PROTOCOL_VERSION,payloadHash} from '../../packages/contracts/validate.mjs';

async function http(t,h){const app=createWorkspaceServer({repository:h.repository}),url=await app.listen();t.after(()=>app.close());return async(path,body,token=h.credential.token)=>{const response=await fetch(url+'/api/v1/'+path,{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:PROTOCOL_VERSION,scope,...body})});return {status:response.status,value:await response.json()};};}
async function confirm(h,claim){const request={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:claim.id,reviewStatus:'confirmed'},grant=h.repository.issueReviewAuthorization(h.auth,request);return h.repository.review(h.auth,{...request,authorizationId:grant.authorizationId}).value;}

test('分类/作者锁、手工候选修订与再次确认经HTTP持久保存，不改原件或复活历史',async t=>{
 const h=await setup(t),post=await http(t,h),original=await importSource(h.repo,input('决定：保留CSV原件。'),await meta(h.repo)),old=(await h.repo.getState()).pending[0];await confirm(h,old);
 const setting={...await meta(h.repo),sourceId:original.source.id,expectedMetadataRevision:0,metadata:{title:'原始数据',category:'调研资料/业务访谈',tags:['数据','访谈'],locked:true}};
 const locked=await post('ui_source_metadata',setting);assert.equal(locked.status,200);assert.equal((await post('ui_source_metadata',setting)).value.revision,1);
 const detail=(await post('ui_claim_detail',{claimId:old.id})).value;
 assert.deepEqual(detail.journey.current.map(c=>c.id),[old.id]);assert.equal(detail.journey.changes.length,0);assert.equal(detail.journey.outcomes.length,0);
 const agentCredential=h.repository.createCredential({ownerId:'test-owner',actorId:'agent',scope,capabilities:['read_memory','write_memory']});const agent=h.repository.authenticate(agentCredential.token),agentRepo=await h.repository.forScope(agent,scope);
 const candidate={type:'fact',title:'自动覆盖',body:'删除CSV',condition:null,evidenceKind:'assistant_statement',evidence:old.evidence,supersedes:[],occurredAt:null};
 await assert.rejects(agentRepo.appendCandidates([candidate],await meta(h.repo)),errorIs('conflict'));assert.equal((await post('ui_source_metadata',{...setting,...await meta(h.repo)},agentCredential.token)).status,403);
 const edit={...await meta(h.repo),claimId:old.id,expectedClaimHash:detail.contentHash,draft:{title:'数据保存方式',body:'保留CSV与整理后的表格。',type:'decision',condition:null},note:'原始数据需要便于核对。'};
 const edited=await post('ui_edit_claim',edit);assert.equal(edited.status,200);assert.equal(edited.value.reviewStatus,'pending');assert.equal(edited.value.evidence.length,1);assert.equal((await post('ui_edit_claim',edit)).value.id,edited.value.id);
 assert.equal((await h.repo.getState()).decisions[0].id,old.id,'编辑不是确认');assert.equal(h.repository.getBlob(h.auth,scope,original.source.id).blob.sha256,original.source.sha256);
 assert.equal((await post('ui_edit_claim',{...edit,...await meta(h.repo),expectedClaimHash:'old'})).status,409);
 const duplicateEdit=await post('ui_edit_claim',{...edit,...await meta(h.repo)});assert.equal(duplicateEdit.status,409);
 const importedAgain=await importSource(h.repo,input('决定：保留CSV原件。'),await meta(h.repo));assert.equal(importedAgain.source.id,original.source.id);assert.equal(importedAgain.warnings[0].code,'conflict');assert.equal((await h.repo.getState()).pending.length,1);
 await confirm(h,edited.value);assert.equal((await h.repo.getState()).decisions[0].id,edited.value.id);assert.equal(h.repository.read(h.auth,scope,'claim',old.id).lifecycle,'superseded');assert.equal(h.repository.read(h.auth,scope,'claim',old.id).effectiveUntil,h.repository.read(h.auth,scope,'claim',edited.value.id).effectiveFrom);assert.ok(h.repository.read(h.auth,scope,'claim',old.id).effectiveUntil);
 const currentDetail=(await post('ui_claim_detail',{claimId:edited.value.id})).value;assert.equal(currentDetail.revisions[0].before.body,old.body);assert.equal(currentDetail.sources[0].locked,true);
 assert.equal(currentDetail.journey.changes[0].reason,edit.note);assert.equal(currentDetail.journey.changes[0].from.body,old.body);assert.equal(currentDetail.journey.changes[0].to.body,edit.draft.body);assert.deepEqual(currentDetail.journey.current.map(c=>c.id),[edited.value.id]);assert.equal(currentDetail.journey.reviews.filter(r=>r.status==='confirmed').length,2);assert.equal(currentDetail.journey.outcomes.length,0,'修改和确认不等于问题已解决');
 await assert.rejects(agentRepo.appendCandidates([{...candidate,evidence:edited.value.evidence,supersedes:[edited.value.id]}],await meta(h.repo)),errorIs('conflict'));
 assert.equal((await post('ui_claim_detail',{claimId:edited.value.id,scope:{...scope,projectId:'other'}})).status,403);
 const draftMeta=await meta(h.repo),draft2=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...edit,...draftMeta,claimId:edited.value.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',edited.value.id))}).value;
 const updatedDraft=h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...edit,...await meta(h.repo),claimId:draft2.id,expectedClaimHash:payloadHash(draft2),draft:{...edit.draft,body:'保留CSV，并核对整理后的表格。'}}).value;await confirm(h,updatedDraft);assert.deepEqual((await h.repo.getState()).decisions.map(c=>c.id),[updatedDraft.id]);
 const compared=await post('ui_compare_claims',{beforeId:old.id,afterId:updatedDraft.id});assert.equal(compared.status,200);assert.ok(compared.value.changes.some(c=>c.field==='body'));assert.equal(compared.value.before.body,old.body);
 const lineage=(await post('ui_claim_detail',{claimId:old.id})).value;assert.equal(lineage.versionCount,4);assert.deepEqual(lineage.current.map(c=>c.id),[updatedDraft.id]);
 const restore={...await meta(h.repo),claimId:updatedDraft.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',updatedDraft.id)),historicalClaimId:old.id,note:'重新采用只保留原件的做法，表格整理暂后置。'};
 const count=h.repository.list(h.auth,scope,'claim').length;h.repository.fault=({method})=>{if(method==='restore_claim')throw new Error('fixture restore rollback');};assert.equal((await post('ui_restore_claim',restore)).status,409);h.repository.fault=null;assert.equal(h.repository.list(h.auth,scope,'claim').length,count);
 assert.equal((await post('ui_restore_claim',restore,agentCredential.token)).status,403);
 const restored=await post('ui_restore_claim',restore);assert.equal(restored.status,200);assert.equal(restored.value.body,old.body);assert.equal(restored.value.reviewStatus,'pending');assert.equal((await h.repo.getState()).decisions[0].id,updatedDraft.id);assert.equal((await post('ui_restore_claim',restore)).value.id,restored.value.id);
 assert.equal((await post('ui_restore_claim',{...restore,...await meta(h.repo),historicalClaimId:draft2.id})).status,409,'未确认历史不能直接恢复');
 await confirm(h,restored.value);assert.deepEqual((await h.repo.getState()).decisions.map(c=>c.id),[restored.value.id]);
 assert.equal((await post('ui_restore_claim',restore)).value.id,restored.value.id,'确认之后原恢复请求仍返回相同回执');
 const metadataHistory=(await post('ui_source_history',{sourceId:original.source.id})).value;assert.equal(metadataHistory.revisions.length,1);assert.equal(metadataHistory.current.locked,true);assert.equal((await post('ui_source_history',{sourceId:original.source.id,scope:{...scope,projectId:'other'}})).status,403);
 await h.reopen();assert.equal(h.repository.sourceMetadata(h.auth,scope,original.source.id).category,'调研资料/业务访谈');assert.equal((await h.repo.getState()).decisions[0].id,restored.value.id);
 const afterReopen=h.repository.claimDetail(h.auth,scope,old.id).journey;assert.deepEqual(afterReopen.current.map(c=>c.id),[restored.value.id]);assert.ok(afterReopen.changes.some(c=>c.restoredFrom===old.id));
 const missing=recordJourney({claims:[{...old,reviewStatus:'confirmed'},{...old,reviewStatus:'confirmed',id:'new-explicit-version',supersedes:[old.id]}],revisions:[],reviews:[],outcomes:[]});assert.equal(missing.changes[0].reason,null);assert.equal(missing.current.length,2,'并行确认不能强制缝合成唯一结论');
});

test('未确认修改、版本守卫、事务回滚与锁后晚到结果保全，已否决记录不能恢复',async t=>{
 const h=await setup(t);await importSource(h.repo,input('背景：人数尚不明确。'),await meta(h.repo));const old=(await h.repo.getState()).pending[0];assert.equal(old.type,'unknown');
 const edit={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:old.id,expectedClaimHash:payloadHash(old),draft:{title:'需要核对人数',body:'人数需要本人确认。',type:'unknown',condition:null},note:'避免把不确定数字当事实。'};
 h.repository.fault=({method})=>{if(method==='edit_claim')throw new Error('fixture transaction');};assert.throws(()=>h.repository.editClaim(h.auth,edit),/fixture transaction/);h.repository.fault=null;assert.equal((await h.repo.getState()).pending.length,1);assert.equal(h.repository.list(h.auth,scope,'source').length,1);
 const next=h.repository.editClaim(h.auth,edit).value;assert.deepEqual((await h.repo.getState()).pending.map(c=>c.id),[next.id]);assert.equal(h.repository.claimDetail(h.auth,scope,next.id).journey.current.length,0);assert.equal((await h.repo.getState()).unknowns.includes(old.body),false);
 const reject={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),claimId:next.id,reviewStatus:'rejected'},grant=h.repository.issueReviewAuthorization(h.auth,reject);h.repository.review(h.auth,{...reject,authorizationId:grant.authorizationId});
 const rejectedMeta=await meta(h.repo);assert.throws(()=>h.repository.editClaim(h.auth,{protocolVersion:PROTOCOL_VERSION,scope,...edit,...rejectedMeta,claimId:next.id,expectedClaimHash:payloadHash(h.repository.read(h.auth,scope,'claim',next.id))}),errorIs('stale_context'));
 assert.equal(h.repository.claimDetail(h.auth,scope,next.id).journey.reviews.at(0).status,'rejected');assert.equal(h.repository.claimDetail(h.auth,scope,next.id).journey.current.length,0);
 const originalSource=old.evidence[0].sourceId,setting={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),sourceId:originalSource,expectedMetadataRevision:0,metadata:{title:'人数资料',category:'项目/背景',tags:[],locked:true}};h.repository.updateSourceMetadata(h.auth,setting);
 const lateMeta=await meta(h.repo);assert.throws(()=>h.repository.updateSourceMetadata(h.auth,{...setting,...lateMeta,requestId:'different',metadata:{...setting.metadata,title:'晚到覆盖'}}),errorIs('stale_context'));
 const invalidMeta=await meta(h.repo);assert.throws(()=>h.repository.updateSourceMetadata(h.auth,{...setting,...invalidMeta,requestId:'invalid-category',expectedMetadataRevision:1,metadata:{...setting.metadata,category:'项目//背景'}}),errorIs('validation_failed'));
});
