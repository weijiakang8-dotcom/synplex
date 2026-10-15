import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,rmSync,realpathSync,existsSync,statSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {spawnSync} from 'node:child_process';

test('恢复入口取消不调用；同一原副本准确传参、失败保留退出码，复制入口拒绝且特殊路径不执行',t=>{
 const root=realpathSync(mkdtempSync(join(tmpdir(),'synplex-recovery-entry-')));t.after(()=>rmSync(root,{recursive:true,force:true}));
 const snapshot=join(root,"备份 ' $HOME"),target=join(root,"恢复 ' $(touch injected.marker) `touch second.marker`"),copy=join(root,'复制位置');
 for(const path of [snapshot,target,copy])mkdirSync(path,{mode:0o700});
 const tool=join(root,'fake transfer.py');writeFileSync(tool,`import json,sys\nfrom pathlib import Path\np=Path(sys.argv[2]);file=p/'calls.json'\ncalls=json.loads(file.read_text()) if file.exists() else []\ncalls.append(sys.argv[1:]);file.write_text(json.dumps(calls))\nsys.exit(7 if (p/'fail').exists() else 0)\n`,{mode:0o600});
 const create=spawnSync('/usr/bin/python3',['-I','-B','-c',`import sys\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1])\nfrom recovery_entry import write_recovery_entry\nwrite_recovery_entry(Path(sys.argv[2]),Path(sys.argv[3]),node=Path(sys.argv[4]),tool=Path(sys.argv[5]),python='/usr/bin/python3')`,resolve('integrations/agenthub'),snapshot,target,process.execPath,tool],{encoding:'utf8',timeout:10000});
 assert.equal(create.status,0,create.stderr);const launcher=join(target,'核对并启用副本.command');assert.equal(statSync(launcher).mode&0o777,0o700);
 const run=(path,input)=>spawnSync('/bin/zsh',[path],{input,encoding:'utf8',cwd:root,timeout:10000});
 const cancelled=run(launcher,'取消\n');assert.equal(cancelled.status,0);assert.match(cancelled.stdout,/已取消/);assert.equal(existsSync(join(target,'calls.json')),false);
 const accepted=run(launcher,'接续\n');assert.equal(accepted.status,0,accepted.stderr);assert.match(accepted.stdout,/核对完成/);
 assert.deepEqual(JSON.parse(readFileSync(join(target,'calls.json'))),[[snapshot,target,'--node',process.execPath,'--human']]);
 writeFileSync(join(target,'fail'),'fixture');const failed=run(launcher,'接续\n');assert.equal(failed.status,7);assert.match(failed.stdout,/保留原目录、备份和副本/);
 copyFileSync(launcher,join(copy,'核对并启用副本.command'));const moved=run(join(copy,'核对并启用副本.command'),'接续\n');assert.equal(moved.status,1);assert.match(moved.stdout,/入口已被移动/);
 assert.equal(JSON.parse(readFileSync(join(target,'calls.json'))).length,2);assert.equal(existsSync(join(root,'injected.marker')),false);assert.equal(existsSync(join(root,'second.marker')),false);
});
