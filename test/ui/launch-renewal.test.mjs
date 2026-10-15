import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,statSync,chmodSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import {LocalProjects} from '../../services/workspace/local-projects.mjs';
import {refreshUiLauncher} from '../../services/workspace/ui-launch.mjs';

const scope={projectId:'launch-fixture',versionId:null,branchId:null},protocolVersion='synplex.workspace/1.0.0';
async function setup(t){
  const dataDir=mkdtempSync(join(tmpdir(),'synplex-launch-')),repository=new WorkspaceRepository({dataDir});
  const human=repository.createCredential({ownerId:'owner',actorId:'local-human',scope,kind:'ui',capabilities:['read_memory','review_memory']});
  const host=repository.createCredential({ownerId:'owner',actorId:'codex-host',scope,capabilities:['read_memory']});
  const connection={scope,uiTokenFile:join(dataDir,'ui-token'),agentTokenFile:join(dataDir,'agent-token')};
  writeFileSync(connection.uiTokenFile,human.token,{mode:0o600});writeFileSync(connection.agentTokenFile,host.token,{mode:0o600});
  const auth=repository.authenticate(human.token),localProjects=new LocalProjects({repository,dataDir,connection,rootAuth:auth});
  const app=createWorkspaceServer({repository,localProjects}),endpoint=await app.listen();
  connection.endpoint=endpoint;writeFileSync(join(dataDir,'connection.json'),JSON.stringify(connection),{mode:0o600});
  t.after(async()=>{await app.close();repository.close();rmSync(dataDir,{recursive:true,force:true});});
  const post=(token,input={protocolVersion,scope},origin)=>fetch(endpoint+'/api/v1/ui_launch',{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{}),...(origin?{Origin:origin}:{})},body:JSON.stringify(input)});
  const pair=nonce=>fetch(endpoint+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:nonce}),redirect:'manual'});
  return {dataDir,repository,human,host,auth,connection,app,endpoint,post,pair};
}

test('launcher renewal requires an authorized human and exact scope, never a host, anonymous or foreign origin',async t=>{
  const f=await setup(t);
  assert.equal((await f.post(null)).status,403);
  assert.equal((await f.post(f.host.token)).status,403);
  assert.equal((await f.post(f.human.token,{protocolVersion,scope},'https://malicious.example')).status,403);
  assert.equal((await f.post(f.human.token,{protocolVersion,scope},'null')).status,403);
  assert.equal((await f.post(f.human.token,{protocolVersion,scope:{...scope,versionId:'other'}})).status,403);
  assert.equal((await f.post(f.human.token,{protocolVersion,scope,actorId:'other'})).status,403);
  const response=await f.post(f.human.token);assert.equal(response.status,200);
  const fresh=await response.json();assert.equal(fresh.endpoint,f.endpoint);
  const paired=await f.pair(fresh.nonce);assert.equal(paired.status,303);
  const cookie=paired.headers.get('set-cookie').split(';')[0];
  const bootstrap=await fetch(f.endpoint+'/api/v1/ui_bootstrap',{headers:{Cookie:cookie}});
  assert.equal(bootstrap.status,200);assert.deepEqual((await bootstrap.json()).scope,scope);
  assert.equal((await f.pair(fresh.nonce)).status,403);
  f.repository.revokeCredential(f.human.id);
  assert.equal((await f.post(f.human.token)).status,403);
});

test('expired code gives an actionable error; renewing it does not execute or alter project state',async t=>{
  const f=await setup(t),before=await (await f.repository.forScope(f.auth,scope)).getState();
  const clock=t.mock.method(Date,'now',()=>new Date().getTime()-360_000);
  const old=await f.app.createUiPairing(f.auth,scope);clock.mock.restore();
  const expired=await f.pair(old.nonce);assert.equal(expired.status,403);
  const error=await expired.json();assert.match(error.message,/过期/);assert.match(error.nextAction,/刷新/);assert.equal(error.retry,'after_input');
  const fresh=await (await f.post(f.human.token)).json();assert.notEqual(fresh.nonce,old.nonce);assert.equal((await f.pair(fresh.nonce)).status,303);
  assert.deepEqual(await (await f.repository.forScope(f.auth,scope)).getState(),before);
  assert.equal(f.repository.list(f.auth,scope,'execution_job').length,0);
});

test('actual connection CLI refreshes a private launcher without printing secrets; unsafe token permissions fail closed',async t=>{
  const f=await setup(t);
  const run=()=>new Promise(resolve=>{
    const child=spawn(process.execPath,['services/workspace/connect.mjs'],{env:{...process.env,SYNPLEX_WORKSPACE_DATA_DIR:f.dataDir},stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',x=>stdout+=x);child.stderr.on('data',x=>stderr+=x);child.on('exit',code=>resolve({code,stdout,stderr}));
  });
  const result=await run();assert.equal(result.code,0);const {launchFile}=JSON.parse(result.stdout);
  const html=readFileSync(launchFile,'utf8'),nonce=html.match(/name="pair" value="([a-f0-9]{64})"/)[1];
  assert.equal(statSync(launchFile).mode&0o077,0);assert.equal((result.stdout+result.stderr).includes(f.human.token),false);assert.equal(result.stdout.includes(nonce),false);
  assert.equal((await f.pair(nonce)).status,303);
  chmodSync(f.connection.uiTokenFile,0o644);
  await assert.rejects(refreshUiLauncher(f.dataDir),/仅本人/);
  const rejected=await run();assert.equal(rejected.code,1);assert.equal(rejected.stderr.includes(f.human.token),false);assert.equal(readFileSync(launchFile,'utf8'),html);
});
