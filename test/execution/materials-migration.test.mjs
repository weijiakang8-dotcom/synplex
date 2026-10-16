import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {snapshotWorkspace,inspectDatabase} from '../../scripts/runtime/recovery.mjs';
import {migrateMaterials} from '../../deploy/migrate-materials.mjs';
import {assertWorkspaceAdmission} from '../../scripts/runtime/handoff-state.mjs';

test('资料迁入新完整后台：原身份与字节保留，拒绝重复和旧执行连接',async t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'synplex-materials-migration-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const scope={projectId:'local-project',versionId:null,branchId:null};
 const setup=dir=>{mkdirSync(dir,{mode:0o700,recursive:true});const repo=new WorkspaceRepository({dataDir:dir});initialConnection(repo,{dataDir:dir,scope,port:5200});repo.close();};
 const original=join(root,'original'),snapshot=join(root,'snapshot'),full=join(root,'full'),target=join(full,'workspace');setup(original);setup(target);
 writeFileSync(join(original,'保留原件.md'),'决定与来源不能丢。',{mode:0o600});
 writeFileSync(join(target,'product-start.json'),JSON.stringify({workspaceDataDir:target,engineRoot:join(full,'engine')}),{mode:0o600});
 writeFileSync(join(target,'executors.json'),'{"fresh":true}',{mode:0o600});
 await snapshotWorkspace(original,snapshot);const before=inspectDatabase(join(original,'workspace.sqlite'));
 const result=migrateMaterials(snapshot,full);assert.equal(result.fingerprint,before.contentHash);
 assert.deepEqual(inspectDatabase(join(target,'workspace.sqlite')),before);assert.equal(readFileSync(join(target,'保留原件.md'),'utf8'),'决定与来源不能丢。');
 const c=JSON.parse(readFileSync(join(target,'connection.json')));assert.equal(c.uiTokenFile,join(target,'connections/ui-token'));assert.equal(readFileSync(c.uiTokenFile,'utf8'),readFileSync(join(original,'connections/ui-token'),'utf8'));
 assert.equal(readFileSync(join(target,'executors.json'),'utf8'),'{"fresh":true}');assert.ok(existsSync(result.bootstrap));
 assert.equal(existsSync(join(target,'recovery.json')),false);
 assert.equal(JSON.parse(readFileSync(join(target,'materials-recovery.json'))).executorsEnabled,false);
 assert.doesNotThrow(()=>assertWorkspaceAdmission(target));
 const receipt=join(full,'materials-migration.json'),complete=readFileSync(receipt,'utf8');
 writeFileSync(receipt,JSON.stringify({...JSON.parse(complete),status:'prepared'}),{mode:0o600});
 assert.throws(()=>assertWorkspaceAdmission(target),/恢复接续尚未完整核对/);
 writeFileSync(receipt,complete,{mode:0o600});
 assert.doesNotThrow(()=>assertWorkspaceAdmission(target));
 assert.throws(()=>migrateMaterials(snapshot,full),/已有迁移记录/);
 // A legacy executor, even without a visible task, must never be rebound.
 const oldEngine=join(root,'old-engine'),unsafe=join(root,'unsafe');setup(oldEngine);writeFileSync(join(oldEngine,'executors.json'),'{}',{mode:0o600});await snapshotWorkspace(oldEngine,unsafe);
 assert.throws(()=>migrateMaterials(unsafe,join(root,'untouched')),/仅迁移/);assert.equal(existsSync(join(root,'untouched')),false);
});
