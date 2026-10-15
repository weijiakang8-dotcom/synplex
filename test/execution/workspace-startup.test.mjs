import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
async function sparePort(){const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));return port;}
function boot(t,env){
  const p=spawn(process.execPath,['services/workspace/server.mjs'],{cwd:root,env:{...process.env,...env},stdio:['ignore','pipe','pipe']});
  let out='',err='',done=false;
  const exit=new Promise(r=>p.once('exit',code=>{done=true;r(code)}));
  const ready=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Isolated startup timeout')),3000);p.stderr.on('data',b=>err+=b);p.stdout.on('data',b=>{out+=b;if(out.includes('\n')){clearTimeout(timer);try{resolve(JSON.parse(out.split('\n')[0]))}catch(e){reject(e)}}});p.once('exit',code=>{clearTimeout(timer);if(!out)reject(new Error(`Service exited: ${code}: ${err}`))});});
  t.after(async()=>{if(!done)p.kill('SIGTERM');await exit;});
  return {ready,async stop(){if(!done)p.kill('SIGTERM');return exit;}};
}

test('actual CLI uses an isolated loopback service and preserves credentials and DB on restart',async t=>{
  const dir=mkdtempSync(join(tmpdir(),'synplex-start-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
  const port=await sparePort(),scope={projectId:'startup-fixture',versionId:null,branchId:null};
  const env={SYNPLEX_WORKSPACE_DATA_DIR:dir,SYNPLEX_WORKSPACE_PORT:String(port),SYNPLEX_WORKSPACE_SCOPE:JSON.stringify(scope)};
  const first=boot(t,env),started=await first.ready;
  assert.equal(started.url,`http://127.0.0.1:${port}`);assert.equal(started.capabilities.execution,false);assert.equal(started.capabilities.import,true);
  const connection=JSON.parse(readFileSync(started.connectionFile)),token=readFileSync(connection.agentTokenFile,'utf8');
  assert.equal(statSync(connection.agentTokenFile).mode&0o077,0);assert.equal(statSync(join(dir,'workspace.sqlite')).mode&0o077,0);
  const response=await fetch(`${started.url}/api/v1/get_project_state`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope})});
  assert.equal(response.status,200);assert.equal((await response.json()).stateRevision,0);
  assert.equal(await first.stop(),0);
  const reordered=JSON.stringify({branchId:null,projectId:scope.projectId,versionId:null}),second=boot(t,{...env,SYNPLEX_WORKSPACE_SCOPE:reordered});
  await second.ready;assert.equal(readFileSync(connection.agentTokenFile,'utf8'),token);assert.equal(await second.stop(),0);
});
