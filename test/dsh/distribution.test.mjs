import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,mkdirSync,rmSync,existsSync,chmodSync,symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { buildDistribution } from '../../plugins/distribution.mjs';
import { toolDefinitions } from '../../services/workspace/service.mjs';
import {buildCodex} from '../../plugins/build-codex.mjs';
import {buildDsh} from '../../plugins/build-dsh.mjs';
test('both downloadable extension archives work outside source tree and contain paths, never credential bytes',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'synplex-packages-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const token='a'.repeat(43),tokenFile=join(dir,'host-token');writeFileSync(tokenFile,token,{mode:0o600});
 const connection={endpoint:'http://127.0.0.1:59999',tokenFile,scope:{projectId:'package-fixture',versionId:null,branchId:null}};
 const connectionFile=join(dir,'fixture-connection.json');writeFileSync(connectionFile,JSON.stringify(connection),{mode:0o600});
 for(const host of ['codex','dsh']){
  const build=target=>host==='codex'?buildCodex(target,{endpoint:connection.endpoint,scope:connection.scope,agentTokenFile:tokenFile}):buildDsh(target,connectionFile);
  const protectedDir=join(dir,host+'-protected');mkdirSync(protectedDir);const keep=join(protectedDir,'keep');writeFileSync(keep,'existing package or host data');
  assert.throws(()=>build(protectedDir),/不会覆盖/);assert.equal(readFileSync(keep,'utf8'),'existing package or host data');assert.equal(existsSync(join(protectedDir,'bundle-incomplete.json')),false);
  const linked=join(dir,host+'-linked');symlinkSync(protectedDir,linked);assert.throws(()=>build(linked),/不会覆盖/);assert.equal(readFileSync(keep,'utf8'),'existing package or host data');
  const dangling=join(dir,host+'-dangling'),destination=join(dir,host+'-missing');symlinkSync(destination,dangling);assert.throws(()=>build(dangling),/不会覆盖/);assert.equal(existsSync(destination),false);
  const invalid=join(dir,host+'-invalid');chmodSync(tokenFile,0o644);assert.throws(()=>build(invalid),/本人可读/);assert.equal(existsSync(invalid),false);chmodSync(tokenFile,0o600);
  const bytes=await buildDistribution(host,connection),archive=join(dir,host+'.tgz'),target=join(dir,host);writeFileSync(archive,bytes);mkdirSync(target);
  const extract=spawnSync('/usr/bin/tar',['-xzf',archive,'-C',target]);assert.equal(extract.status,0);
  const bundle=join(target,'synplex-'+host);
  const listing=spawnSync('/usr/bin/tar',['-tzf',archive],{encoding:'utf8'});assert.equal(listing.status,0);assert.equal(/node_modules|ui-token|SQLite|\.db|bundle-incomplete/.test(listing.stdout),false);
  if(host==='codex'){
    const manifest=JSON.parse(readFileSync(join(bundle,'plugins/synplex-workspace/mcp.json'),'utf8'));assert.equal(manifest.mcpServers['synplex-workspace'].env.SYNPLEX_WORKSPACE_TOKEN_FILE,tokenFile);
    assert.equal(JSON.stringify(manifest).includes(token),false);
    assert.deepEqual(JSON.parse(readFileSync(join(bundle,'plugins/synplex-workspace/scripts/tools.json'),'utf8')),toolDefinitions());
  }else{
    const saved=readFileSync(join(bundle,'connection.json'),'utf8');assert.equal(saved.includes(token),false);
    const {createBridge}=await import(pathToFileURL(join(bundle,'adapters/dsh/bridge.mjs')).href);const bridge=createBridge(JSON.parse(saved));assert.equal(bridge.tools.length,6);
    const unbound=bridge.tools.map(tool=>{const out=structuredClone(tool);delete out.inputSchema.properties.scope.const;return out;});assert.deepEqual(unbound,toolDefinitions());
    assert.equal(JSON.parse(readFileSync(join(bundle,'package.json'),'utf8')).dsh.bundle.patch,'./cordis.patch.yml');
  }
 }
});
