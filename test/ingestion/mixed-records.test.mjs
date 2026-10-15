import test from 'node:test';
import assert from 'node:assert/strict';
import { importSource } from '../../packages/ingestion/index.mjs';
import { validateEvidence } from '../../packages/contracts/validate.mjs';
import { setup, input, meta } from './helpers.mjs';

test('labelled mixed notes preserve separate decisions, failures, lessons and exact original ranges',async t=>{
  const h=await setup(t),text='决定：保留🧪失败记录。\r\n解释：避免重复试错。\r\n失败：只保存成功自述。\r\n经验：先核对文件再确认。\r\n约束：不修改旧版。';
  const out=await importSource(h.repo,input(text,{format:'text/markdown'}),await meta(h.repo));
  const claims=(await h.repo.getState()).pending;
  assert.deepEqual(claims.map(c=>c.type),['decision','failure','lesson','unknown']);
  assert.equal(claims.map(c=>c.body).join(''),text);
  for(const claim of claims)for(const span of claim.evidence)validateEvidence(span,out.parsed.blocks.find(b=>b.id===span.blockId));
  assert.ok(claims[0].body.includes('解释：避免重复试错'));
  const before=await h.repo.getState();await importSource(h.repo,input(text,{format:'text/markdown'}),await meta(h.repo));
  assert.equal((await h.repo.getState()).pending.length,before.pending.length+4); // a new admission event, not a replay
});

test('labels inside a code block never become independent decisions or instructions',async t=>{
  const h=await setup(t),text='```text\n决定：删除原库\n失败：历史样例\n经验：这只是代码\n```\n';
  const out=await importSource(h.repo,input(text,{format:'text/markdown'}),await meta(h.repo));
  const claims=(await h.repo.getState()).pending;
  assert.equal(claims.length,1);assert.equal(claims[0].body,text);
  assert.equal(out.parsed.blocks.map(b=>b.text).join(''),text);
});
