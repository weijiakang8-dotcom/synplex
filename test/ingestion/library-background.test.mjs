import test from 'node:test';
import assert from 'node:assert/strict';
import {setup,input,meta,scope,errorIs} from './helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
import {chatBackground} from '../../services/workspace/chat-service.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';

test('资料与待核对分页读完不漏项；新导入使旧页失效，重启保留原件与准确数量',async t=>{
 const h=await setup(t);
 for(let i=0;i<102;i++)await importSource(h.repo,input('决定：保存独立资料 '+i),await meta(h.repo));
 const first=h.repository.materialPage(h.auth,scope),last=h.repository.materialPage(h.auth,scope,first.cursor);
 assert.equal(first.sources.length,100);assert.equal(last.sources.length,2);assert.equal(last.cursor,null);
 assert.equal(new Set([...first.sources,...last.sources].map(x=>x.id)).size,102);
 const pending=h.repository.pendingPage(h.auth,scope),tail=h.repository.pendingPage(h.auth,scope,pending.cursor);
 assert.equal(pending.total,102);assert.equal(tail.items.length,2);
 assert.equal(h.repository.state(h.auth,scope,{pendingLimit:100}).pending.length,100);assert.equal((await h.repo.getState()).pending.length,102);
 const before=h.repository.importStatus(h.auth,scope);await h.reopen();assert.deepEqual(h.repository.importStatus(h.auth,scope),before);
 await importSource(h.repo,input('决定：追加资料'),await meta(h.repo));
 assert.throws(()=>h.repository.materialPage(h.auth,scope,first.cursor),errorIs('stale_context'));
 const foreign=h.repository.createCredential({ownerId:'other',actorId:'reader',scope,kind:'ui',capabilities:['read_memory']});
 assert.throws(()=>h.repository.materialPage(h.repository.authenticate(foreign.token),scope,first.cursor),errorIs('stale_context'));assert.equal(h.repository.materialPage(h.repository.authenticate(foreign.token),scope).sources.length,0);
});

test('复盘检索带入实测表而非只取计划；出处精确、排除记录和跨项目边界仍生效',async t=>{
 const h=await setup(t),text='# 成本量化实验\n\n计划：测量成本和结果，尚未执行。\n\n## 实测结果\n\n2026年10月，共6次合成对照。\n\n|方式|合格|参考费用|\n|---|---|---|\n|A|3/3|0.12|\n|B|3/3|0.18|\n\n结论：B费用高50%，不是实付，不证明生产收益。';
 await importSource(h.repo,input(text,{format:'text/markdown'}),await meta(h.repo));
 const state=await h.repo.getState(),request={scope,requestId:'retrieval',content:'有没有量化数据证明效果，成本如何？',excludedClaimIds:[]};
 const packet=await chatBackground(h.repository,h.auth,request,64000);
 assert.ok(packet.evidence.some(e=>e.quote.includes('|B|3/3|0.18|')));assert.ok(packet.sourceReferences.length);
 for(const e of packet.evidence){const source=h.repository.read(h.auth,scope,'parsed',e.parsedRevisionId),block=source.blocks.find(b=>b.id===e.blockId);assert.equal(block.text.slice(e.start,e.end),e.quote);}
 const table=state.pending.find(c=>c.evidence.some(e=>e.quote.includes('|B|3/3|0.18|')));
 const excluded=await chatBackground(h.repository,h.auth,{...request,excludedClaimIds:[table.id]},64000);
 assert.equal(excluded.evidence.some(e=>e.quote.includes('|B|3/3|0.18|')),false);
 assert.deepEqual(await h.repo.getState(),state);
 const {contentHash,...body}=packet;assert.equal(contentHash,payloadHash(body));
});

test('后台整理推进修订时，只重试明确拒收的上传；未知响应保留原身份且不重发',async()=>{
 const {admitNote}=await import('../../public/obsidian-import.js'),oldFetch=globalThis.fetch,values=new Map(),storage={setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)},calls=[];
 const c={storage,request:async()=>({stateRevision:8})},metadata={requestId:'same-note',expectedStateRevision:7},item={path:'笔记.md',file:{name:'笔记.md'},bytes:new TextEncoder().encode('原文 [[链接]]')};
 try{
  globalThis.fetch=async(_url,options)=>{calls.push(JSON.parse(options.body.get('metadata')));return calls.length===1?{ok:false,status:409,json:async()=>({code:'stale_context'})}:{ok:true,status:202,json:async()=>({operation:{id:'original',status:'queued'}})};};
  assert.equal((await admitNote(c,item,scope,'pending',metadata)).operation.id,'original');assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[1].expectedStateRevision,8);
  let attempts=0;globalThis.fetch=async()=>{attempts++;throw Error('response lost');};await assert.rejects(admitNote(c,item,scope,'unknown',metadata),/response lost/);assert.equal(attempts,1);assert.equal(JSON.parse(values.get('unknown')).metadata.requestId,'same-note');
 }finally{globalThis.fetch=oldFetch;}
});
