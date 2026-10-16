import test from 'node:test';
import assert from 'node:assert/strict';
import {selectEvent} from '../../packages/ingestion/event-selection.mjs';
import {setup,input,meta,scope} from './helpers.mjs';
import {importSource} from '../../packages/ingestion/index.mjs';
const claim=body=>({id:'test',body,evidenceKind:'historical_tool_text',evidence:[{}],condition:'仅为原文规则候选，待核对'});
test('event gate keeps constraints, turning points, negative outcomes and unknown results; excludes noise and external history',()=>{
 for(const text of ['决定：原方案会丢失依据，改为保留原件后再整理。','失败：完整主链路尚未通过，不能把健康检查当完成。','约束：必须保留旧稿，不能覆盖原文件。','经验：下次先核对原请求，再恢复任务，避免重复执行。'])assert.equal(selectEvent({claim:claim(text)}).selected,true,text);
 for(const text of ['你好，谢谢。','普通文字，仅仅介绍一个概念。','# 如何创建一个任务','```js\nthrow Error("失败")\n```'])assert.equal(selectEvent({claim:claim(text)}).selected,false,text);
 assert.equal(selectEvent({claim:claim('决定：采用长连接避免重复建立连接。'),sourcePath:'计算机知识基础/网络/连接.md'}).selected,false);
 assert.equal(selectEvent({claim:claim('实测：核心链路全部通过，不能丢失历史。'),sourcePath:'_附件/求职与面试/半岛医疗/拿手菜提交稿.pptx'}).selected,false);
 assert.equal(selectEvent({claim:{...claim('人工修改，保留。'),evidenceKind:'user_statement'}}).selected,true);
});
test('review projection is reversible and deduplicates only identical pending text, retaining originals and manual decisions',async t=>{
 const h=await setup(t);
 for(const text of ['你好，谢谢。','决定：保留原稿后再生成新版，避免修改覆盖。','决定：保留原稿后再生成新版，避免修改覆盖。','决定：不采用旧方案，因为其遗漏关键要求。'])await importSource(h.repo,input(text),await meta(h.repo));
 const original=h.repository.list(h.auth,scope,'claim'),before=await h.repo.getState(),page=h.repository.pendingPage(h.auth,scope);
 assert.equal(page.total,2);assert.equal(page.selection.retainedInSources,2);assert.equal(page.selection.unreviewedFragments,4);
 assert.deepEqual(h.repository.list(h.auth,scope,'claim'),original);assert.equal((await h.repo.getState()).stateRevision,before.stateRevision);
 const request={protocolVersion:'synplex.workspace/1.0.0',scope,...await meta(h.repo),claimId:page.items[0].id,reviewStatus:'confirmed'};
 const grant=h.repository.issueReviewAuthorization(h.auth,request);h.repository.review(h.auth,{...request,authorizationId:grant.authorizationId});
 assert.equal((await h.repo.getState()).decisions.length,1);await h.reopen();assert.equal((await h.repo.getState()).decisions.length,1);
 assert.equal(h.repository.list(h.auth,scope,'source').length,3);assert.equal(h.repository.list(h.auth,scope,'claim').length,4);
});

test('absent, scalar or malformed note identities cannot break project reads and task preparation',async t=>{
 const h=await setup(t);
 for(const sessionId of [null,'null','42','[]','{"path":null}','{"path":5}'])await importSource(h.repo,input('决定：保留原件后再修改，不能丢失历史。',{sessionId}),await meta(h.repo));
 assert.equal(h.repository.pendingPage(h.auth,scope).total,1);
 assert.equal((await h.repo.getContextState()).pending.length,1);
});

test('整理后的经验不会被较新的原文片段挤出入口，且不自动确认',async t=>{
 const h=await setup(t);
 await importSource(h.repo,input('经验：先核对原结果再继续，不重复执行。'),await meta(h.repo));
 const raw=h.repository.list(h.auth,scope,'claim')[0];
 await h.repo.appendCandidates([{type:'lesson',title:'中断先核对',body:'经验：先核对原结果再继续，不重复执行。',condition:'已整理；适用于中断后原请求状态未知的情况。',evidenceKind:'historical_tool_text',evidence:raw.evidence,occurredAt:null,supersedes:[]}],await meta(h.repo));
 await importSource(h.repo,input('普通资料片段。\n\n'.repeat(130)),await meta(h.repo));
 const page=h.repository.pendingLessons(h.auth,scope);
 assert.equal(page.total,1);assert.equal(page.items[0].title,'中断先核对');assert.equal(page.items[0].reviewStatus,'pending');
 assert.equal(h.repository.pendingPage(h.auth,scope).items[0].title,'中断先核对');
 const overview=await h.repo.getSummaryState();assert.ok(overview.pending.length<=100);assert.equal(overview.pending[0].title,'中断先核对');assert.match(overview.unknowns.at(-1),/概览不是完整历史/);
 assert.equal((await h.repo.getState()).lessons.length,0);
 assert.throws(()=>h.repository.pendingLessons(h.auth,{...scope,projectId:'unrelated'}));
 await h.reopen();assert.equal(h.repository.pendingLessons(h.auth,scope).total,1);
});

test('样例产物不能因提炼或项目关键词变成本人经验；真实验收记录与人工判断保留',async t=>{
 const path='_附件/项目/AgentHub/真实任务验收/example.md';
 const body='Synplex真实验收：决定改为自动下单，已通过。[[项目/AgentHub/项目主页]]';
 for(const condition of ['仅为原文规则候选，待核对','已整理；下次可以复用'])assert.equal(selectEvent({claim:{...claim(body),condition},sourcePath:path,primaryTopic:'AgentHub'}).selected,false);
 assert.equal(selectEvent({claim:{...claim(body),evidenceKind:'user_statement'},sourcePath:path,primaryTopic:'AgentHub'}).selected,true);
 assert.equal(selectEvent({claim:claim('实测：本次聊天通过，改稿失败；结果不等于完整业务验收。'),sourcePath:'项目/AgentHub/真实任务验收.md',primaryTopic:'AgentHub'}).selected,true);
 const h=await setup(t);
 await importSource(h.repo,input(body,{sessionId:JSON.stringify({vault:'笔记库',path})}),await meta(h.repo));
 const raw=h.repository.list(h.auth,scope,'claim')[0],before=h.repository.list(h.auth,scope,'claim');
 await h.repo.appendCandidates([{type:'lesson',title:'样例教训',body,condition:'已整理；下次可以复用',evidenceKind:'historical_tool_text',evidence:raw.evidence,occurredAt:null,supersedes:[]}],await meta(h.repo));
 assert.equal(h.repository.pendingPage(h.auth,scope).total,0);assert.equal(h.repository.pendingLessons(h.auth,scope).total,0);
 assert.equal(h.repository.list(h.auth,scope,'claim').length,before.length+1);
 const manual={...await meta(h.repo),claimId:raw.id,reviewStatus:'confirmed',protocolVersion:'synplex.workspace/1.0.0',scope};
 const grant=h.repository.issueReviewAuthorization(h.auth,manual);h.repository.review(h.auth,{...manual,authorizationId:grant.authorizationId});
 await h.reopen();assert.equal((await h.repo.getState()).decisions.length,1);
});
