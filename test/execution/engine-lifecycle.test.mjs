import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';

test('引擎运行期互斥包含直接入口、父进程退出和锁内恢复核对',()=>{
 const result=spawnSync('/usr/bin/python3',['-B','scripts/integration/engine-lease-check.py'],{encoding:'utf8',timeout:40000});
 assert.equal(result.status,0,result.stderr);
 const evidence=JSON.parse(result.stdout);
 assert.equal(evidence.supervisedChildKeepsLeaseAfterParentExit,true);
 assert.equal(evidence.configurationCheckedUnderLease,true);
 assert.equal(evidence.directEntrypointsRequireExclusiveAndPreflight,true);
 assert.equal(evidence.modelCalls,0);
});

test('旧稿读取修复只能迁移精确评估的只读工具改动，不能接受其他程序变化',()=>{
 const result=spawnSync('/usr/bin/python3',['-B','scripts/integration/document-reader-patch-check.py'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/modelCalls=0/);
});

test('停用的收费评估保留原消息；实际待办、未知回执与其他项目任务继续阻止重启',()=>{
 const result=spawnSync('/usr/bin/python3',['-B','scripts/integration/disabled-evaluation-check.py'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);
 assert.match(result.stdout,/modelCalls=0/);
});

test('执行回复/文稿适配迁移只接受精确已评估改动，拒绝额外代码与回执替身',()=>{
 const result=spawnSync('/usr/bin/python3',['-B','scripts/integration/worker-output-patch-check.py'],{encoding:'utf8',timeout:10000});
 assert.equal(result.status,0,result.stderr);assert.match(result.stdout,/modelCalls=0/);
});
