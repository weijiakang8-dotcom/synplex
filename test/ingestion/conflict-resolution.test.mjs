import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {importSource} from '../../packages/ingestion/index.mjs';
import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {setup,input,meta,scope,errorIs} from './helpers.mjs';
import {prepareContext} from '../../packages/context/index.mjs';

for(const action of ['keep_existing','keep_separate'])test(`human conflict resolution ${action} preserves both sources and survives reopening`,async t=>{
  const h=await setup(t),eventId=randomUUID();
  await importSource(h.repo,input('第一版选择：保留本地文件。',{eventId}),await meta(h.repo));
  await assert.rejects(importSource(h.repo,input('第二版选择：改为远程文件。',{eventId}),await meta(h.repo)),errorIs('conflict'));
  const original=h.repository.list(h.auth,scope,'occurrence')[0];
  const [conflict]=h.repository.conflictDetails(h.auth,scope);
  assert.match(conflict.existingText,/第一版/);assert.match(conflict.incomingText,/第二版/);
  const req={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),conflictId:conflict.id,action,note:'经原件核对，保留两份出处。'};
  const outcome=h.repository.resolveConflict(h.auth,req);
  assert.equal(h.repository.resolveConflict(h.auth,req).duplicate,true);
  assert.deepEqual(h.repository.read(h.auth,scope,'occurrence',original.id),original);
  assert.equal((await h.repo.getState()).conflicts.length,0);
  assert.equal(h.repository.list(h.auth,scope,'source').length,2);
  assert.equal(h.repository.list(h.auth,scope,'occurrence').length,action==='keep_separate'?2:1);
  assert.equal(h.repository.list(h.auth,scope,'claim').filter(c=>c.reviewStatus==='confirmed').length,0);
  await h.reopen();assert.equal((await h.repo.getState()).conflicts.length,0);
  assert.equal(h.repository.conflictDetails(h.auth,scope)[0].resolution.id,outcome.value.id);
  await assert.rejects(importSource(h.repo,input('第三版：另一次变化。',{eventId}),await meta(h.repo)),errorIs('conflict'));
  assert.equal((await h.repo.getState()).conflicts.length,1,'a new conflicting payload needs another explicit review');
});

test('conflict resolution rejects stale, foreign, malformed and agent input without clearing blockers',async t=>{
  const h=await setup(t),eventId=randomUUID();
  await importSource(h.repo,input('原资料',{eventId}),await meta(h.repo));
  await assert.rejects(importSource(h.repo,input('变化资料',{eventId}),await meta(h.repo)),errorIs('conflict'));
  const req={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),conflictId:h.repository.conflictDetails(h.auth,scope)[0].id,action:'keep_existing',note:'保留旧来源'};
  assert.throws(()=>h.repository.resolveConflict(h.auth,{...req,expectedStateRevision:0}),errorIs('stale_context'));
  assert.throws(()=>h.repository.resolveConflict(h.auth,{...req,action:'replace'}),errorIs('validation_failed'));
  assert.throws(()=>h.repository.resolveConflict(h.auth,{...req,conflictId:'foreign'}),errorIs('scope_denied'));
  const agent=h.repository.authenticate(h.repository.createCredential({ownerId:'test-owner',actorId:'agent',scope,capabilities:['read_memory','write_memory']}).token);
  assert.throws(()=>h.repository.resolveConflict(agent,req),errorIs('scope_denied'));
  assert.equal((await h.repo.getState()).conflicts.length,1);
});

test('human correction and merge append a sourced current conclusion, preserve history and reject unrelated replacement',async t=>{
 const h=await setup(t);
 for(const action of ['correct','merge']){
  const eventId=randomUUID(),old=await importSource(h.repo,input('民宿房间数为20。',{eventId}),await meta(h.repo));
  const oldClaim=(await h.repo.getState()).pending.find(c=>c.evidence[0].sourceId===old.source.id);
  await assert.rejects(importSource(h.repo,input('民宿房间数为22，其中2间备用。',{eventId}),await meta(h.repo)),errorIs('conflict'));
  const q=h.repository.conflictDetails(h.auth,scope).find(q=>!q.resolution);
  const req={protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),conflictId:q.id,action,note:'逐间核对；两份原件均保留。',replacement:{type:'fact',title:'可售房间数量',body:'可售房间20间，另外2间备用。',condition:null,supersedes:[oldClaim.id]}};
  assert.throws(()=>h.repository.resolveConflict(h.auth,{...req,replacement:{...req.replacement,supersedes:['foreign']}}),errorIs('scope_denied'));
  const result=h.repository.resolveConflict(h.auth,req),corrected=h.repository.read(h.auth,scope,'claim',result.value.claimId);
  assert.equal(corrected.reviewStatus,'confirmed');assert.equal(corrected.evidenceKind,'user_statement');
  assert.equal(h.repository.read(h.auth,scope,'claim',oldClaim.id).lifecycle,'superseded');
  assert.equal(h.repository.resolveConflict(h.auth,req).duplicate,true);
  assert.equal(h.repository.getBlob(h.auth,scope,old.source.id).blob.sha256,old.source.sha256);
  assert.match(Buffer.from(h.repository.getBlob(h.auth,scope,corrected.evidence[0].sourceId).bytes).toString(),/可售房间20间/);
  await h.reopen();assert.equal((await h.repo.getState()).conflicts.length,0);
  assert.ok((await h.repo.getState()).facts.some(c=>c.id===corrected.id));
  assert.equal(h.repository.list(h.auth,scope,'claim_revision').filter(r=>r.claimId===oldClaim.id).length,1);
 }
});

test('explicit unrelated sources can continue while selected conflicts and global safety conflicts remain blocking',async t=>{
 const h=await setup(t),eventId=randomUUID();
 const original=await importSource(h.repo,input('民宿房间有20间。',{eventId}),await meta(h.repo));
 await assert.rejects(importSource(h.repo,input('民宿房间有22间。',{eventId}),await meta(h.repo)),errorIs('conflict'));
 const unrelated=await importSource(h.repo,input('Python报表采用CSV格式。'),await meta(h.repo));
 const prepare=async selectedOccurrenceIds=>prepareContext(h.repo,{protocolVersion:PROTOCOL_VERSION,scope,...await meta(h.repo),goal:'Python报表',constraints:[],acceptanceCriteria:['CSV文件'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds,maxInputTokens:12000},{reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1'});
 assert.equal((await prepare([unrelated.occurrences[0].id])).conflicts.length,0);
 assert.equal((await prepare([original.occurrences[0].id])).coverage,'needs_input');
 assert.equal((await prepare([])).coverage,'needs_input','没有指定资料时，不猜测冲突无关');
 const boundary=randomUUID();await importSource(h.repo,input('禁止外发客户资料。',{eventId:boundary}),await meta(h.repo));
 await assert.rejects(importSource(h.repo,input('允许外发客户资料。',{eventId:boundary}),await meta(h.repo)),errorIs('conflict'));
 assert.equal((await prepare([unrelated.occurrences[0].id])).coverage,'needs_input');
 assert.equal((await h.repo.getState()).conflicts.length,2,'筛选不删除历史冲突');
});
