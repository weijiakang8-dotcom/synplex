import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createInterface} from 'node:readline';
import {mkdtempSync,mkdirSync,rmSync,writeFileSync,existsSync,symlinkSync,unlinkSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {acquireWorkspaceLease,WORKSPACE_LEASE_FILES} from '../../scripts/runtime/workspace-lease.mjs';
import {snapshotWorkspace,verifySnapshot,inspectDatabase,restoreWorkspace} from '../../scripts/runtime/recovery.mjs';

test('联合维护跨Python和Node保留同一锁，阻止直接服务/重复备份，进程中断后可重新取得且不改原任务',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-maintenance-')),dataDir=join(dir,'中文项目','workspace'),backup=join(dir,'backup');
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 const repo=new WorkspaceRepository({dataDir}),scope={projectId:'maintenance-fixture',versionId:null,branchId:null};
 repo.createCredential({ownerId:'fixture',actorId:'human',scope,kind:'ui',capabilities:['read_memory']});repo.close();
 // An offline bookkeeping fixture; no task, credentialed endpoint or executor.
 writeFileSync(join(dataDir,'connection.json'),JSON.stringify({scope,endpoint:'http://127.0.0.1:5411',uiTokenFile:join(dataDir,'ui-token'),agentTokenFile:join(dataDir,'agent-token')}),{mode:0o600});
 for(const name of ['ui-token','agent-token'])writeFileSync(join(dataDir,name),'synthetic-not-a-real-key',{mode:0o600});
 const before=inspectDatabase(join(dataDir,'workspace.sqlite')),original=readFileSync(join(dataDir,'connection.json'));
 let child,server;
 t.after(async()=>{for(const process of [server,child])if(process&&process.exitCode===null&&process.signalCode===null){process.kill('SIGTERM');await once(process,'exit');}rmSync(dir,{recursive:true,force:true});});
 const python=`import sys,json\nfrom pathlib import Path\nsys.path.insert(0,'integrations/agenthub')\nfrom workspace_maintenance import workspace_maintenance\nwith workspace_maintenance(Path(sys.argv[1]),Path(sys.argv[2])) as guard:\n guard.request('backup',Path(sys.argv[3]))\n assert guard.request('verify-source',Path(sys.argv[3]))['unchanged']\n assert guard.request('compare-source',Path(sys.argv[3]))['unchanged']\n assert guard.request('check-unused')['unused']\n print(json.dumps({'ready':True}),flush=True)\n sys.stdin.readline()\n`;
 child=spawn('/usr/bin/python3',['-B','-c',python,process.execPath,dataDir,backup],{cwd:resolve('.'),stdio:['pipe','pipe','pipe']});
 let errors='';child.stderr.on('data',data=>errors+=data);
 const lines=createInterface({input:child.stdout});
 const first=await Promise.race([once(lines,'line').then(([line])=>JSON.parse(line)),once(child,'exit').then(([code])=>{throw Error(`Maintenance exited ${code}: ${errors}`);})]);
 assert.equal(first.ready,true);
 assert.throws(()=>acquireWorkspaceLease(dataDir),/仍在使用或维护/);
 const refused=join(dir,'must-not-exist');await assert.rejects(snapshotWorkspace(dataDir,refused),/仍在使用或维护/);assert.equal(existsSync(refused),false);
 server=spawn(process.execPath,['services/workspace/server.mjs'],{cwd:resolve('.'),env:{...process.env,SYNPLEX_WORKSPACE_DATA_DIR:dataDir,SYNPLEX_WORKSPACE_PORT:'5411',SYNPLEX_WORKSPACE_SCOPE:JSON.stringify(scope)},stdio:['ignore','ignore','pipe']});
 let serverError='';server.stderr.on('data',data=>serverError+=data);const [exit]=await once(server,'exit');assert.equal(exit,1);assert.match(serverError,/仍在使用或维护/);
 assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),before);assert.deepEqual(readFileSync(join(dataDir,'connection.json')),original);
 const manifest=verifySnapshot(backup);assert.deepEqual(manifest.data,before);assert.equal(manifest.files.some(f=>WORKSPACE_LEASE_FILES.includes(f.path)),false);
 // Kill only our own Python owner. EOF makes its owned Node guard release the
 // transaction; no stale-lock removal and no signal to an observed process.
 child.kill('SIGKILL');await once(child,'exit');lines.close();
 let lease;const deadline=Date.now()+5000;
 while(!lease){try{lease=acquireWorkspaceLease(dataDir);}catch(error){if(Date.now()>deadline)throw error;await new Promise(yes=>setTimeout(yes,20));}}
 lease.close();assert.deepEqual(inspectDatabase(join(dataDir,'workspace.sqlite')),before);
 const restored=restoreWorkspace(backup,join(dir,'restored'),{port:5412});assert.deepEqual(restored.data,before);assert.equal(restored.executorsEnabled,false);
 // Guard-file substitution must be rejected; the original file is retained.
 const lock=join(dataDir,WORKSPACE_LEASE_FILES[0]),other=join(dir,'other');
 writeFileSync(other,'private original',{mode:0o600});unlinkSync(lock);symlinkSync(other,lock);
 assert.throws(()=>acquireWorkspaceLease(dataDir),/不安全/);assert.equal(readFileSync(other,'utf8'),'private original');
});
