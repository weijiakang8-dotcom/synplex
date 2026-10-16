import test from 'node:test';import assert from 'node:assert/strict';
import {reviewQueue,reviewCount} from '../../public/project-recap.js';
test('原文线索不冒充整理后待核对记录；仍可展开并人工核对，不修改状态',()=>{
 const raw={id:'raw',condition:'仅为原文规则候选，待核对'},ready={id:'ready',condition:'模型整理，等待核对。'},state={pending:[ready,raw]},history={candidateSelection:{curatedEvents:1,rawSignals:1400},pendingTotal:1401,curations:[]},before=structuredClone(state);
 assert.equal(reviewCount(history,state),1);const html=reviewQueue(history,state,50,c=>'<article data-test="'+c.id+'">核对记录</article>',(a,b)=>a+b,String);
 assert.ok(html.indexOf('data-test="ready"')<html.indexOf('<details data-ai-role="source_signals">'));
 assert.ok(html.indexOf('data-test="raw"')>html.indexOf('<details data-ai-role="source_signals">'));
 assert.ok(!html.includes('source_signals" open'));assert.match(html,/1400 条尚未整理/);assert.match(html,/不计入上方待核对数量/);assert.match(html,/data-curate-sources/);assert.deepEqual(state,before);
 assert.equal(reviewCount({pendingTotal:5},state),5,'老服务返回仍有明确兼容');
});
