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
