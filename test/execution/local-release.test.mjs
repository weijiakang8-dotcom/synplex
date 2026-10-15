import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync,symlinkSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,dirname} from 'node:path';
import {installEngineEnvironment} from '../../scripts/runtime/engine-environment.mjs';
import {buildRelease,verifyRelease} from '../../scripts/runtime/release.mjs';
import {spawnSync} from 'node:child_process';

test('发行清单保全锁依赖和文件身份，拒绝缺包/篡改/外部替身且不打包私人配置',t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-release-')),source=join(dir,'source'),target=join(dir,'release');t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const files=['package.json','package-lock.json','services/workspace/server.mjs','scripts/runtime/workspace.mjs','scripts/runtime/release.mjs','public/index.html'];
 for(const path of files){mkdirSync(dirname(join(source,path)),{recursive:true});writeFileSync(join(source,path),path.endsWith('.json')?'{}':'fixture source');}
 writeFileSync(join(source,'.env'),'PRIVATE_SETTING=must-not-ship');mkdirSync(join(source,'.runtime'));writeFileSync(join(source,'.runtime','credentials'),'private');
 assert.equal(spawnSync('git',['init',dir]).status,0);assert.equal(spawnSync('git',['-c','user.name=fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-m','fixture parent'],{cwd:dir}).status,0);
 const manifest=buildRelease(target,{sourceRoot:source});assert.equal(manifest.packagingVerified,true);assert.equal(manifest.fullDeliveryVerified,false);assert.equal(existsSync(join(target,'.env')),false);assert.equal(existsSync(join(target,'.runtime')),false);assert.equal(existsSync(join(target,'release-incomplete.json')),false);verifyRelease(target);
 assert.equal(manifest.commit,null,'nested source must not inherit a parent checkout commit');assert.equal(manifest.sourceCommit,null);
 const manifestPath=join(target,'release.json'),manifestBytes=readFileSync(manifestPath);writeFileSync(manifestPath,JSON.stringify({...manifest,workspaceFeatures:['task-followup/1']}));assert.throws(()=>verifyRelease(target),/能力声明/);writeFileSync(manifestPath,manifestBytes);verifyRelease(target);
 const file=join(target,'services/workspace/server.mjs'),original=readFileSync(file);writeFileSync(file,'modified');assert.throws(()=>verifyRelease(target),/被修改/);writeFileSync(file,original);verifyRelease(target);
 assert.throws(()=>buildRelease(join(source,'public','nested'),{sourceRoot:source}),/独立目录/);
 mkdirSync(join(source,'node_modules'));const dependency=join(source,'node_modules','fixture.js');writeFileSync(dependency,'// locked runtime');
 const bundled=join(dir,'bundled');buildRelease(bundled,{sourceRoot:source,includeDependencies:true});
 const reused=join(dir,'reused');buildRelease(reused,{sourceRoot:source,includeDependencies:true,dependencyRelease:bundled});verifyRelease(reused);assert.equal(readFileSync(join(reused,'node_modules/fixture.js'),'utf8'),'// locked runtime');
 writeFileSync(join(source,'package-lock.json'),'{"different":true}');assert.throws(()=>buildRelease(join(dir,'lock-mismatch'),{sourceRoot:source,includeDependencies:true,dependencyRelease:bundled}),/依赖锁/);writeFileSync(join(source,'package-lock.json'),'{}');
 writeFileSync(join(bundled,'node_modules/fixture.js'),'// changed');assert.throws(()=>buildRelease(join(dir,'bundle-tampered'),{sourceRoot:source,includeDependencies:true,dependencyRelease:bundled}),/被修改/);
 symlinkSync(join(source,'.env'),join(source,'node_modules','escape'));assert.throws(()=>buildRelease(join(dir,'bad-dependency'),{sourceRoot:source,includeDependencies:true}),/外部替身/);
 const backend=join(source,'vendor/backend');mkdirSync(backend,{recursive:true});const lock=join(backend,'requirements.lock');writeFileSync(lock,Array.from({length:20},(_,i)=>`fixture-${i}==1.0.0`).join('\n'));
 const occupied=join(dir,'existing-environment');mkdirSync(occupied);writeFileSync(join(occupied,'keep'),'original environment');
 assert.throws(()=>installEngineEnvironment({environment:occupied,backend,python:'/not-a-python',uv:'/not-an-installer',pgBin:'/not-a-database'}));assert.equal(readFileSync(join(occupied,'keep'),'utf8'),'original environment');
 const nested=join(backend,'must-not-create');assert.throws(()=>installEngineEnvironment({environment:nested,backend}),/源码分开/);assert.equal(existsSync(nested),false);
 writeFileSync(lock,'unreviewed-package>=1.0\n');const invalid=join(dir,'invalid-environment');assert.throws(()=>installEngineEnvironment({environment:invalid,backend}),/固定版本/);assert.equal(existsSync(invalid),false);
 rmSync(join(source,'public/index.html'));assert.throws(()=>buildRelease(join(dir,'missing'),{sourceRoot:source}),/不完整/);
});
