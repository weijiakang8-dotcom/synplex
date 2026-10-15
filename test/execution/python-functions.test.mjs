import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('受限Python函数编译拒绝越界语法，分配与预期类型守卫在免费CI执行',()=>{
 const result=spawnSync('python3',['-B','test/execution/python-function-guards.py'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr||result.error?.message);assert.match(result.stdout,/契约通过/);
});
