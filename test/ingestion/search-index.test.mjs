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

test('默认背景区分项目原记录、展示陈述和其他项目；显式选取保留原文及出处',async t=>{
 const h=await setup(t),phrase='实测结果与可复用经验';
 const add=async(path,body,extra={})=>importSource(h.repo,input(body,{sessionId:JSON.stringify({vault:'笔记库',path}),...extra}),await meta(h.repo));
 const project=[];
 for(let i=0;i<3;i++)project.push(await add(`项目/示例/验证-${i}.md`,`${phrase}：样本${i}尚未通过，不能认定完成。`));
 const other=await add('项目/其他项目/验证.md',`${phrase}：100%通过。`);
 const slides=await add('成长与职业/展示材料/提交稿.pptx',`${phrase}：全部完成，100%通过。`);
 const fixture=await add('_附件/项目/示例/真实任务验收/example.md',`${phrase}：合成方案全部通过。`);
 const query=occurrenceIds=>h.repo.retrieveContext({terms:['实测','经验'],occurrenceIds,limit:48});
 const defaults=await query([]),ids=new Set(defaults.map(r=>r.span.sourceId));
 assert.ok(project.every(p=>ids.has(p.source.id)));assert.ok(!ids.has(other.source.id));assert.ok(!ids.has(slides.source.id));
 assert.ok(!ids.has(fixture.source.id));
 assert.ok(defaults.every(r=>r.span.quote.includes('尚未通过')));
 assert.equal((await query([slides.occurrences[0].id]))[0].evidenceRole,'展示材料，仅表示作者陈述');
 assert.equal((await query([other.occurrences[0].id]))[0].span.sourceId,other.source.id);
 assert.equal((await query([fixture.occurrences[0].id]))[0].evidenceRole,'测试输入或样例产物，不是本人实际经历');
 assert.equal((await h.repo.queryEvidence({query:'100%',limit:100,cursor:null,includeHistory:true,occurrenceIds:null})).items.length,2);
 assert.equal((await h.repo.retrieveContext({terms:['不存在的词'],occurrenceIds:[],limit:48})).length,0);
});

test('复盘问题能取回实际交付与修订段落，不能只给一般经验和负结果',async t=>{
 const h=await setup(t),{prepareContext}=await import('../../packages/context/index.mjs');
 const paragraphs=[...Array.from({length:8},(_,i)=>`经验${i}：经验、复盘、失败与根因需要保留，协作、协商、分歧和取舍不能被遗漏。`),'限定样本的闭环记录：'+'本段只是背景说明。'.repeat(25)+'同一任务导出初稿，读取旧稿修订，再下载新旧文件，结果分别核对；样本仅一次，未测总体完成率。','用户提出网页与扩展双向补齐，纠正重复模块；讨论改变了原来的交付方案。'];
 const source=await importSource(h.repo,input(paragraphs.join('\n\n'),{format:'text/markdown',sessionId:JSON.stringify({vault:'验收资料',path:'项目/示例/项目实测记录.md'})}),await meta(h.repo));
 const packet=await prepareContext(h.repo,{protocolVersion:'synplex.workspace/1.0.0',scope,...await meta(h.repo),goal:'有哪些量化数据证明好用？留下什么经验？人机讨论有哪些火花？',constraints:[],acceptanceCriteria:['有原文依据'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:24000},{reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1'});
 assert.ok(packet.evidence.some(e=>e.sourceId===source.source.id&&e.quote.includes('读取旧稿修订')));
 assert.ok(packet.evidence.some(e=>e.quote.includes('限定样本的闭环记录：')&&e.quote.includes('读取旧稿修订')));
 assert.ok(packet.evidence.some(e=>e.quote.includes('用户提出网页与扩展双向补齐')));
 assert.ok(packet.evidence.every(e=>e.quoteHash));
 assert.equal(Buffer.from((await h.repo.getBlob(source.source.id)).bytes).toString(),paragraphs.join('\n\n'));
});

test('多个章节标题和泛化任务词不能挤掉明确点名的更正与取舍依据',async t=>{
 const h=await setup(t),{prepareContext}=await import('../../packages/context/index.mjs');
 const add=async(name,body)=>importSource(h.repo,input(body,{format:'text/markdown',sessionId:JSON.stringify({vault:'验收资料',path:`项目/示例/${name}.md`})}),await meta(h.repo));
 for(let i=0;i<9;i++)await add(`任务说明${i}`,`任务必须有来源和验收，实测依据、可复用经验与人机讨论形成任务复盘。任务有输入、输出与限制，记录未测范围。`);
 const correction='用户指出“管家”只是示例，纠正后统一到已有“待办”入口，不扩大功能边界。';
 const tradeoff='用户提出网页版与扩展版双向补齐：背景和成果共用，执行工具可以替换。';
 await add('实际讨论',correction+'\n\n'+tradeoff);
 const packet=await prepareContext(h.repo,{protocolVersion:'synplex.workspace/1.0.0',scope,...await meta(h.repo),goal:'请把任务写成“实测依据”“可复用经验”“人机讨论”三部分。必须解释“管家”如何被纠正为“待办”，以及“网页版与扩展版双向补齐”的取舍。每部分有来源，保留未测范围。',constraints:[],acceptanceCriteria:['来源可核对'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:64000},{reservedTokens:512,estimatorVersion:'utf8-bytes-conservative/1'});
 assert.ok(packet.evidence.some(e=>e.quote.includes(correction)));
 assert.ok(packet.evidence.some(e=>e.quote.includes(tradeoff)));
});


test('同主题当前原记录优先于历史快照，明确选中仍可读取原历史',async t=>{
 const h=await setup(t),phrase='工作台保存项目经历与依据，核对成果。';
 const current=await importSource(h.repo,input(phrase,{sessionId:JSON.stringify({vault:'笔记库',path:'项目/示例/当前记录.md'})}),await meta(h.repo));
 const old=await importSource(h.repo,input(phrase+' 这是旧定位。',{sessionId:JSON.stringify({vault:'历史快照',path:'项目/示例/早期记录.md'})}),await meta(h.repo));
 const plan=await importSource(h.repo,input('---\ntype: plan\nstatus: active\n---\n\n'+phrase,{format:'text/markdown',sourceSystem:'user-markdown',sessionId:JSON.stringify({vault:'笔记库',path:'项目/示例/后续计划.md'})}),await meta(h.repo));
 const historical=await importSource(h.repo,input('---\ntype: note\nstatus: historical\n---\n\n'+phrase,{format:'text/markdown',sourceSystem:'user-markdown',sessionId:JSON.stringify({vault:'笔记库',path:'项目/示例/过去记录.md'})}),await meta(h.repo));
 const baseline=await importSource(h.repo,input('---\ntype: analysis\nstatus: completed\nsource_baseline: "abc123"\ncode_revision: "def456"\n---\n\n'+phrase,{format:'text/markdown',sourceSystem:'user-markdown',sessionId:JSON.stringify({vault:'笔记库',path:'项目/示例/能力对标.md'})}),await meta(h.repo));
 const query=occurrenceIds=>h.repo.retrieveContext({terms:['工作台','项目经历','依据'],occurrenceIds,limit:48});
 const hits=await query([]);assert.equal(hits[0].span.sourceId,current.source.id);
 assert.match(hits.find(x=>x.span.sourceId===old.source.id).evidenceRole,/历史/);
 assert.match(hits.find(x=>x.span.sourceId===historical.source.id).evidenceRole,/历史/);
 assert.match(hits.find(x=>x.span.sourceId===baseline.source.id).evidenceRole,/历史/);
 assert.match(hits.find(x=>x.span.sourceId===plan.source.id).evidenceRole,/计划.*不证明/);
 assert.equal((await query([plan.occurrences[0].id]))[0].span.sourceId,plan.source.id);
 assert.equal((await query([old.occurrences[0].id]))[0].span.sourceId,old.source.id);
 assert.equal(Buffer.from((await h.repo.getBlob(old.source.id)).bytes).toString(),phrase+' 这是旧定位。');
});
