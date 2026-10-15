import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,cpSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {seedRecoveryWorkspace} from '../../scripts/testing/recovery-fixture.mjs';
import {seedIdleRecoveryWorkspace} from '../../scripts/testing/idle-recovery-fixture.mjs';
import {verifyHandoffIntegrity} from '../../scripts/runtime/handoff-integrity.mjs';
import {snapshotWorkspace,restoreWorkspace,inspectDatabase,verifySnapshot,listFiles} from '../../scripts/runtime/recovery.mjs';
import {acquireWorkspaceLease} from '../../scripts/runtime/workspace-lease.mjs';
import {assertWorkspaceAdmission,HANDOFF_PROTOCOL} from '../../scripts/runtime/handoff-state.mjs';
import {auditHandoffWorkspace,prepareHandoffWorkspace} from '../../scripts/runtime/handoff-workspace.mjs';
import {loadExecutors} from '../../services/workspace/executors.mjs';
import {requiredDataFeatures,assertDataFeatures} from '../../scripts/runtime/data-compatibility.mjs';

test('闲置恢复以两份原目录停用凭据接管，中途true标记不能启动；保持原绑定和文件，拒绝换副本/缺凭据',async t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'synplex-idle-handoff-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const sourceEngine=join(dir,'source-engine'),sourceWorkspace=join(dir,'source-workspace'),snapshot=join(dir,'snapshot'),target=join(dir,'restored'),targetWorkspace=join(target,'workspace'),targetEngine=join(target,'engine');
 const write=(file,value)=>writeFileSync(file,JSON.stringify(value),{mode:0o600});
 for(const root of [sourceEngine,join(sourceEngine,'engine'),snapshot,join(snapshot,'engine/engine'),target,targetEngine,join(targetEngine,'engine')])mkdirSync(root,{recursive:true,mode:0o700});
 const original={id:'fixture-engine',api_port:5422,redis_port:5423,workflow_id:randomUUID()};
 const ids=seedIdleRecoveryWorkspace(sourceWorkspace,sourceEngine,original,randomUUID());
 write(join(sourceEngine,'engine/bootstrap.json'),original);
 write(join(snapshot,'engine/engine/bootstrap.json'),original);
 write(join(targetEngine,'engine/bootstrap.json'),{...original,api_port:5432,redis_port:5433});
 write(join(targetEngine,'engine-startup.json'),{format:'synplex.engine-startup/1',infrastructureId:'restored-infra',apiPort:5432,redisPort:5433,databasePort:5434,backend:'/evaluated/fixture',providerConfigured:false,lockSha256:'fixture'});
 await snapshotWorkspace(sourceWorkspace,join(snapshot,'workspace'));restoreWorkspace(join(snapshot,'workspace'),targetWorkspace,{port:5431});
 const originalHash=inspectDatabase(join(sourceWorkspace,'workspace.sqlite')),before=inspectDatabase(join(targetWorkspace,'workspace.sqlite'));
 assert.deepEqual(before,originalHash);
 // Even an accidentally copied configuration cannot enable a disabled restore.
 cpSync(join(targetWorkspace,'executors.before-recovery.json'),join(targetWorkspace,'executors.json'));
 assert.deepEqual(loadExecutors(targetWorkspace),{});rmSync(join(targetWorkspace,'executors.json'));
 const proof={format:HANDOFF_PROTOCOL,id:randomUUID(),snapshot,snapshotSha256:'a'.repeat(64),source:{workspace:sourceWorkspace,engine:sourceEngine,engineId:original.id,infrastructureId:'original-infra'},target:{workspace:targetWorkspace,engine:targetEngine,engineId:original.id,infrastructureId:'restored-infra'}};
 const intent=join(target,'handoff-intent.json');write(intent,{proof,python:'/usr/bin/python3'});
 const tools={inspectDatabase,verifySnapshot,listFiles},sourceLease=acquireWorkspaceLease(sourceWorkspace),targetLease=acquireWorkspaceLease(targetWorkspace);
 try{
  assert.equal(auditHandoffWorkspace(sourceLease,intent,tools).unchanged,true);
  assert.equal(auditHandoffWorkspace(targetLease,intent,tools).unchanged,true);
  assert.throws(()=>prepareHandoffWorkspace(targetLease,intent,tools));
  write(join(sourceEngine,'handoff-retired.json'),proof);
  assert.throws(()=>prepareHandoffWorkspace(targetLease,intent,tools));
  write(join(sourceWorkspace,'handoff-retired.json'),proof);
  const prepared=prepareHandoffWorkspace(targetLease,intent,tools);
  assert.equal(prepared.prepared,true);assert.equal(prepared.oldBindingsChanged,false);
  const legacy=join(dir,'legacy-release');mkdirSync(legacy,{mode:0o700});
  for(const workspace of [sourceWorkspace,targetWorkspace]){
   const database=join(workspace,'workspace.sqlite');
   assert.ok(requiredDataFeatures(database).includes('idle-product-handoff/1'));
   assert.throws(()=>assertDataFeatures(legacy,database),/不能完整理解/);
   assertDataFeatures(resolve('.'),database);
  }
  assert.throws(()=>assertWorkspaceAdmission(targetWorkspace),/恢复接续|ENOENT/);
  assert.throws(()=>assertWorkspaceAdmission(sourceWorkspace),/原工作台已停止使用/);
  // Repeat ONLY preparation of the same intent; no task or binding is created.
  prepareHandoffWorkspace(targetLease,intent,tools);
  assert.equal(auditHandoffWorkspace(targetLease,intent,tools).workspaceFingerprint,before.contentHash);
  write(join(targetEngine,'recovery.json'),{executorsEnabled:true,handoff:proof});
  write(join(target,'handoff-complete.json'),proof);
  assertWorkspaceAdmission(targetWorkspace);
  assert.deepEqual(inspectDatabase(join(targetWorkspace,'workspace.sqlite')),before);
  const journal=join('executors/agenthub',ids.completed.operationId+'.json');
  assert.deepEqual(readFileSync(join(targetWorkspace,journal)),readFileSync(join(sourceWorkspace,journal)));
  assert.equal(JSON.parse(readFileSync(join(targetWorkspace,'executors.json'))).synplex.tokenFile,join(targetEngine,'engine/access-token'));
  const marker=join(sourceEngine,'handoff-retired.json'),exact=readFileSync(marker);
  write(marker,{...proof,id:randomUUID()});assert.throws(()=>assertWorkspaceAdmission(targetWorkspace),/恢复接续/);writeFileSync(marker,exact);
  const other=join(dir,'another-workspace');cpSync(targetWorkspace,other,{recursive:true});assert.throws(()=>assertWorkspaceAdmission(other),/恢复接续/);
  const python=spawnSync('/usr/bin/python3',['-I','-B',resolve('test/execution/idle-handoff-guards.py'),resolve('integrations/agenthub'),target],{encoding:'utf8',timeout:10000});
  assert.equal(python.status,0,python.stderr);assert.match(python.stdout,/modelCalls=0/);
  assert.equal(payloadHash(inspectDatabase(join(sourceWorkspace,'workspace.sqlite'))),payloadHash(originalHash));
 }finally{targetLease.close();sourceLease.close();}
 // Direct server entry checks retirement before opening the repository.
 const blocked=spawnSync(process.execPath,['services/workspace/server.mjs'],{env:{...process.env,SYNPLEX_WORKSPACE_DATA_DIR:sourceWorkspace,SYNPLEX_WORKSPACE_PORT:'5411'},encoding:'utf8',timeout:10000});
 assert.equal(blocked.status,1);assert.match(blocked.stderr,/原工作台已停止使用/);
});

test('只读身份夹具不等于可启动工作台：孤立任务缺少关联操作时，在停用原实例前拒绝',t=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),'synplex-orphan-handoff-')));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const workspace=join(dir,'workspace');seedRecoveryWorkspace(workspace,join(dir,'engine'),{api_port:5422,workflow_id:randomUUID()},{completed:randomUUID()});
 assert.throws(()=>verifyHandoffIntegrity(workspace),/原任务关联记录或工作台入口不完整/);
});
