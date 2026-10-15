import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import { WorkspaceConnector } from '../../adapters/codex/connector.mjs';
import { toolDefinitions } from '../../services/workspace/service.mjs';
import { PROTOCOL_VERSION } from '../../packages/contracts/validate.mjs';

const scope={projectId:'transport-fixture',versionId:'v2',branchId:null};
const root=resolve(fileURLToPath(new URL('../..',import.meta.url)));
async function setup(t) {
  const dir=mkdtempSync(join(tmpdir(),'synplex-mcp-')),repo=new WorkspaceRepository({dataDir:join(dir,'data')});
  const credential=repo.createCredential({ownerId:'owner',actorId:'codex',scope,capabilities:['read_memory','write_memory','prepare_task','record_result'],kind:'agent'});
  const tokenFile=join(dir,'token');writeFileSync(tokenFile,credential.token,{mode:0o600});
  const app=createWorkspaceServer({repository:repo}),url=await app.listen();
  t.after(async()=>{await app.close();repo.close();rmSync(dir,{recursive:true,force:true});});
  return {dir,repo,credential,tokenFile,url,app};
}
function clientProcess(t,path,env) {
  const child=spawn(process.execPath,[path],{env:{...process.env,...env},stdio:['pipe','pipe','pipe']});
  const waiting=new Map(),messages=[];let seq=0,stderr='';
  child.stderr.on('data',b=>stderr+=b);
  createInterface({input:child.stdout}).on('line',line=>{let value;try{value=JSON.parse(line)}catch{throw new Error('MCP stdout contained non-protocol text')};messages.push(value);const p=waiting.get(value.id);if(p){waiting.delete(value.id);clearTimeout(p.timer);p.resolve(value);}});
  const exit=new Promise(resolve=>child.once('exit',code=>{for(const p of waiting.values()){clearTimeout(p.timer);p.reject(new Error(`MCP exited with code ${code}`));}waiting.clear();resolve();}));
  t.after(async()=>{child.stdin.end();await exit;assert.equal(stderr.includes('Bearer '),false);});
  return {child,messages,rpc(method,params={}){const id=++seq;return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{waiting.delete(id);reject(new Error('MCP timeout'))},3000);waiting.set(id,{resolve,reject,timer});child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');});}};
}

test('connector uses private scoped credentials, rejects redirects/external endpoints and permissionless token files',async t=>{
  const {dir,url,tokenFile}=await setup(t),connector=new WorkspaceConnector({endpoint:url,tokenFile,scope});
  const state=await connector.call('get_project_state',{protocolVersion:PROTOCOL_VERSION});assert.deepEqual(state.scope,scope);
  const reordered={branchId:null,versionId:'v2',projectId:scope.projectId};assert.deepEqual((await connector.call('get_project_state',{protocolVersion:PROTOCOL_VERSION,scope:reordered})).scope,scope);
  await assert.rejects(connector.call('get_project_state',{protocolVersion:PROTOCOL_VERSION,scope:{...scope,versionId:null}}),e=>e.code==='scope_denied');
  assert.throws(()=>new WorkspaceConnector({endpoint:'https://example.com',tokenFile,scope}),e=>e.code==='scope_denied');
  chmodSync(tokenFile,0o644);await assert.rejects(connector.call('get_project_state',{protocolVersion:PROTOCOL_VERSION}),e=>e.code==='scope_denied');chmodSync(tokenFile,0o600);
  const link=join(dir,'link');symlinkSync(tokenFile,link);const unsafe=new WorkspaceConnector({endpoint:url,tokenFile:link,scope});
  await assert.rejects(unsafe.call('get_project_state',{protocolVersion:PROTOCOL_VERSION}),e=>e.code==='scope_denied');
});

test('real stdio negotiates supported protocol, lists six scoped tools and calls actual SQLite HTTP',async t=>{
  const {url,tokenFile}=await setup(t),client=clientProcess(t,join(root,'adapters/codex/mcp.mjs'),{
    SYNPLEX_WORKSPACE_URL:url,SYNPLEX_WORKSPACE_TOKEN_FILE:tokenFile,SYNPLEX_WORKSPACE_SCOPE:JSON.stringify(scope)});
  assert.equal((await client.rpc('tools/list')).error.code,-32002);
  const init=await client.rpc('initialize',{protocolVersion:'unknown-later-version'});assert.equal(init.result.protocolVersion,'2025-06-18');
  const list=await client.rpc('tools/list');assert.equal(list.result.tools.length,6);assert.deepEqual(list.result.tools[0].inputSchema.properties.scope.const,scope);
  const result=await client.rpc('tools/call',{name:'get_project_state',arguments:{protocolVersion:PROTOCOL_VERSION,scope}});
  assert.equal(result.result.isError,undefined);assert.deepEqual(result.result.structuredContent.scope,scope);
  const unavailable=await client.rpc('tools/call',{name:'prepare_task',arguments:{protocolVersion:PROTOCOL_VERSION,scope,requestId:'mcp-prep',expectedStateRevision:0,goal:'整理项目',constraints:[],acceptanceCriteria:['有原文依据'],mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:1000}});
  assert.equal(unavailable.result.isError,true);assert.equal(JSON.parse(unavailable.result.content[0].text).code,'capability_unavailable');
});

test('portable package retains only recognized assets and uses paths rather than token bodies',async t=>{
  const {dir,url,tokenFile,credential}=await setup(t),connectionFile=join(dir,'connection.json');
  writeFileSync(connectionFile,JSON.stringify({endpoint:url,scope,agentTokenFile:tokenFile}),{mode:0o600});
  const result=JSON.parse(execFileSync(process.execPath,['plugins/build-codex.mjs',connectionFile,join(dir,'marketplace')],{cwd:root,encoding:'utf8'}));
  const plugin=join(result.marketplace,'plugins','synplex-workspace'),mcp=JSON.parse(readFileSync(join(plugin,'mcp.json')));
  assert.equal(mcp.mcpServers['synplex-workspace'].env.SYNPLEX_WORKSPACE_TOKEN_FILE,tokenFile);
  assert.equal(readFileSync(join(plugin,'mcp.json'),'utf8').includes(credential.token),false);
  const client=clientProcess(t,join(plugin,'scripts','mcp.mjs'),mcp.mcpServers['synplex-workspace'].env);
  await client.rpc('initialize',{protocolVersion:'2025-06-18'});
  const response=await client.rpc('tools/call',{name:'get_project_state',arguments:{protocolVersion:PROTOCOL_VERSION,scope}});
  assert.deepEqual(response.result.structuredContent.scope,scope);
});

test('bundled tool schema stays identical to the frozen service definitions',()=>{
  assert.deepEqual(JSON.parse(readFileSync(join(root,'adapters/codex/tools.json'))),toolDefinitions());
});
