import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {buildRelease} from '../../scripts/runtime/release.mjs';
import {inspectDatabase} from '../../scripts/runtime/recovery.mjs';
import {initializeInstallation,upgradeInstallation,rollbackInstallation,reconcileUpgrade,openInstallation} from '../../scripts/runtime/upgrade.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';
import {spawnSync} from 'node:child_process';

test('坏升级在副本检查，原子切换中断按实际指针核对；回退只换兼容程序，不回滚新成果和费用记录',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-upgrade-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const data=join(dir,'data'),manager=join(dir,'installation'),scope={projectId:'upgrade-fixture',versionId:null,branchId:null};
 const repo=new WorkspaceRepository({dataDir:data}),credential=repo.createCredential({ownerId:'fixture',actorId:'ui',kind:'ui',scope,capabilities:['read_memory','write_memory']}),auth=repo.authenticate(credential.token),scoped=await repo.forScope(auth,scope);
 await scoped.saveBlob({bytes:Buffer.from('升级前的真实文件'),format:'text/plain'},{requestId:'before-upgrade',expectedStateRevision:0});repo.close();
 mkdirSync(join(data,'connections'),{mode:0o700});writeFileSync(join(data,'connections/token'),credential.token,{mode:0o600});writeFileSync(join(data,'connection.json'),JSON.stringify({endpoint:'http://127.0.0.1:15996',scope,uiTokenFile:join(data,'connections/token'),agentTokenFile:join(data,'connections/token')}),{mode:0o600});
 const doctor=`import {readFileSync} from 'node:fs';import {join} from 'node:path';const d=process.env.SYNPLEX_WORKSPACE_DATA_DIR;if(!d.includes('probe'))throw Error('must inspect staged copy');const r=JSON.parse(readFileSync(join(d,'recovery.json')));if(r.executorsEnabled!==false)throw Error('must remain disabled');`;
 const release=(name,script,features=[])=>{const source=join(dir,name+'-source'),target=join(dir,name);for(const path of ['package.json','package-lock.json','services/workspace/server.mjs','scripts/runtime/workspace.mjs','scripts/runtime/release.mjs','public/index.html']){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),path.endsWith('.json')?'{}':path==='scripts/runtime/workspace.mjs'?script:'// '+name);}if(features.length){mkdirSync(join(source,'migrations'));writeFileSync(join(source,'migrations/workspace-features.json'),JSON.stringify({format:'synplex.workspace-features/1',features}));}buildRelease(target,{sourceRoot:source});return realpathSync(target);};
 const first=release('first',doctor),second=release('second',doctor+'\n// revised program'),bad=release('bad',doctor+'\nprocess.exit(3);'),mutating=release('mutating',doctor+`\nimport {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(join(d,'workspace.sqlite'));db.exec('UPDATE scopes SET state_revision=state_revision+1');db.close();`);
 const baseline=inspectDatabase(join(data,'workspace.sqlite'));await initializeInstallation(manager,first,data);
 const state=()=>JSON.parse(readFileSync(join(manager,'installation.json'),'utf8'));assert.equal(state().current.path,first);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),baseline);
 const file=join(second,'public/index.html'),content=readFileSync(file);writeFileSync(file,'tampered');await assert.rejects(upgradeInstallation(manager,second),/被修改/);assert.equal(existsSync(join(manager,'.upgrade-lock')),false);writeFileSync(file,content);
 await assert.rejects(upgradeInstallation(manager,bad),/启动检查未通过/);assert.equal(state().current.path,first);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),baseline);assert.equal(reconcileUpgrade(manager).status,'not_switched');
 await assert.rejects(upgradeInstallation(manager,mutating),/改变了副本资料/);assert.equal(state().current.path,first);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),baseline);assert.equal(reconcileUpgrade(manager).status,'not_switched');
 await assert.rejects(upgradeInstallation(manager,second,{fault:phase=>{if(phase==='prepared'){assert.throws(()=>reconcileUpgrade(manager),/仍在运行/);throw Error('fixture interruption before switch');}}}),/before switch/);assert.equal(state().current.path,first);assert.equal(reconcileUpgrade(manager).status,'not_switched');
 await assert.rejects(upgradeInstallation(manager,second,{fault:phase=>{if(phase==='switched')throw Error('fixture interruption after switch');}}),/after switch/);assert.equal(state().current.path,second);await assert.rejects(openInstallation(manager,{openBrowser:false}),/尚未核对/);assert.equal(reconcileUpgrade(manager).status,'completed_after_interruption');
 await assert.rejects(upgradeInstallation(manager,second),/不重复/);
 // A later file and append-only cost evidence must survive rollback. This is
 // a persistence fixture, not a claim of a paid provider billing validation.
 const later=new WorkspaceRepository({dataDir:data}),laterAuth=later.authenticate(credential.token),laterScope=await later.forScope(laterAuth,scope);await laterScope.saveBlob({bytes:Buffer.from('新版期间新增成果'),format:'text/plain'},{requestId:'after-upgrade',expectedStateRevision:(await laterScope.getState()).stateRevision});later.close();
 const db=new DatabaseSync(join(data,'workspace.sqlite')),partition=db.prepare('SELECT partition FROM scopes LIMIT 1').get().partition,evidence={id:'fixture-cost-evidence',costUsd:0.12,provenance:'isolated fixture, not real spend'};db.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,'fixture_cost_evidence',evidence.id,payloadHash(evidence),JSON.stringify(evidence));db.close();
 const latest=inspectDatabase(join(data,'workspace.sqlite'));assert.notEqual(latest.contentHash,baseline.contentHash);
 const rolled=await rollbackInstallation(manager);assert.equal(rolled.state.current.path,first);assert.equal(rolled.databaseRestored,false);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),latest);
 const manifestPath=join(second,'release.json'),manifest=JSON.parse(readFileSync(manifestPath,'utf8'));writeFileSync(manifestPath,JSON.stringify({...manifest,dataCompatibility:{workspaceSchemaVersions:[2],engineUpgrade:'not_included'}}));await assert.rejects(upgradeInstallation(manager,second),/兼容声明/);writeFileSync(manifestPath,JSON.stringify(manifest));
 await upgradeInstallation(manager,second);writeFileSync(join(second,'public/index.html'),'bad after activation');assert.equal((await rollbackInstallation(manager)).state.current.path,first);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),latest);writeFileSync(join(second,'public/index.html'),content);
 // A bad activated candidate after a lost response is also reverted by code
 // identity, without restoring a snapshot over more recent business records.
 await assert.rejects(upgradeInstallation(manager,second,{fault:phase=>{if(phase==='switched'){writeFileSync(join(second,'public/index.html'),'broken after switch');throw Error('fixture bad activation');}}}),/bad activation/);
 assert.equal(reconcileUpgrade(manager).status,'previous_code_restored');assert.equal(state().current.path,first);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),latest);
 // The same SQL schema can contain semantics an old program cannot read.
 // A local manager must reject that rollback before taking a switch lock.
 const aware=release('aware',doctor,['task-followup/1','task-result-selection/1']);await upgradeInstallation(manager,aware);
 const features=new DatabaseSync(join(data,'workspace.sqlite'));
 for(const kind of ['task_followup','task_result_selection']){const row={id:kind+'-fixture',fixtureOnly:true};features.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,kind,row.id,payloadHash(row),JSON.stringify(row));}features.close();
 const semantic=inspectDatabase(join(data,'workspace.sqlite')),beforePointer=state();
 await assert.rejects(rollbackInstallation(manager),/不能完整理解/);assert.deepEqual(state(),beforePointer);assert.equal(existsSync(join(manager,'.upgrade-lock')),false);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),semantic);
 const launcher=spawnSync('/bin/zsh',[join(manager,'回退上一版.command')],{input:'\n',encoding:'utf8',timeout:10000});assert.equal(launcher.status,1);assert.match(launcher.stderr,/不能完整理解/);assert.deepEqual(state(),beforePointer,'真实回退启动器也必须保留最新兼容管理逻辑');
 await assert.rejects(initializeInstallation(join(dir,'unsafe-old-installation'),first,data),/不能完整理解/);assert.equal(existsSync(join(dir,'unsafe-old-installation')),false);
 const supported=release('aware-next',doctor+'\n// semantic compatible',['task-followup/1','task-result-selection/1']);await upgradeInstallation(manager,supported);await rollbackInstallation(manager);assert.equal(state().current.path,aware);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),semantic);
 const approvalAware=release('approval-aware',doctor+'\n// approval details',['task-followup/1','task-result-selection/1','operation-approval/1']);await upgradeInstallation(manager,approvalAware);
 const approvalDb=new DatabaseSync(join(data,'workspace.sqlite')),question={id:'approval-fixture',prompt:{approval:{snapshotHash:'a'.repeat(64)}}};
 approvalDb.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,'execution_question',question.id,payloadHash(question),JSON.stringify(question));approvalDb.close();
 const beforeApprovalRollback=inspectDatabase(join(data,'workspace.sqlite'));await assert.rejects(rollbackInstallation(manager),/不能完整理解/);assert.equal(state().current.path,approvalAware);assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),beforeApprovalRollback);
 // A retirement witness is an execution constraint even if its contents are
 // incomplete. Reject old code before probing or switching either direction.
 const witness=join(data,'handoff-retired.json');writeFileSync(witness,'incomplete fixture',{mode:0o600});
 await assert.rejects(upgradeInstallation(manager,approvalAware),/不能完整理解/);
 await assert.rejects(initializeInstallation(join(dir,'pre-handoff-manager'),approvalAware,data),/不能完整理解/);
 assert.equal(readFileSync(witness,'utf8'),'incomplete fixture');assert.equal(state().current.path,approvalAware);
 assert.deepEqual(inspectDatabase(join(data,'workspace.sqlite')),beforeApprovalRollback);
});
