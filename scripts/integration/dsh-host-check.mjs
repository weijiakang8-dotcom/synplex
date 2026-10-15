import assert from 'node:assert/strict';
import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';
import { createWorkspaceServer } from '../../services/workspace/http.mjs';
import * as context from '../../packages/context/index.mjs';
import { buildDsh } from '../../plugins/build-dsh.mjs';

// Actual published Cordis/MCP-client/tools, no mocks and no model. Install only
// into this dedicated prefix using the pinned command in adapters/dsh/README.
const host=resolve('.runtime/dsh-host-check'),moduleAt=p=>import(pathToFileURL(join(host,'node_modules',p)).href);
const {Context}=await moduleAt('@deepseek-ai/cordis/lib/index.js');
const {default:ToolRuntime}=await moduleAt('@deepseek-ai/dsh-tools/lib/index.js');
const {default:SystemPrompt}=await moduleAt('@deepseek-ai/dsh-system-prompt/lib/index.js');
const dir=mkdtempSync(join(tmpdir(),'synplex-real-dsh-runtime-')),scope={projectId:'host-fixture',versionId:null,branchId:null};
const repository=new WorkspaceRepository({dataDir:join(dir,'data')}),app=createWorkspaceServer({repository,modules:{context}});
const endpoint=await app.listen(),credential=repository.createCredential({ownerId:'fixture',actorId:'dsh-host',scope,capabilities:['read_memory','write_memory','prepare_task','record_result']});
const tokenFile=join(dir,'token');writeFileSync(tokenFile,credential.token,{mode:0o600});
const connectionFile=join(dir,'connection.json');writeFileSync(connectionFile,JSON.stringify({endpoint,tokenFile,scope}),{mode:0o600});
const target=join(host,'node_modules/@synplex/dsh-workspace');buildDsh(target);
const plugin=await import(pathToFileURL(join(target,'adapters/dsh/extension.mjs')).href),ctx=new Context();
try{
  await ctx.plugin(SystemPrompt);await ctx.plugin(ToolRuntime);const fiber=ctx.plugin(plugin,{connectionFile});await fiber;
  const call=async(name,args)=>{
    const out=await ctx.tools.execute({callId:randomUUID(),name:`mcp__synplex_workspace__${name}`,arguments:args,signal:new AbortController().signal});
    assert.equal(out.isError,false,JSON.stringify(out));
    return JSON.parse(out.content.find(x=>x.type==='text').text);
  };
  assert.equal(ctx.tools.schemas().filter(x=>x.name.startsWith('mcp__synplex_workspace__')).length,6);
  const state=await call('get_project_state',{protocolVersion:'synplex.workspace/1.0.0',scope});assert.deepEqual(state.scope,scope);
  const prepared=await call('prepare_task',{protocolVersion:'synplex.workspace/1.0.0',scope,requestId:randomUUID(),expectedStateRevision:state.stateRevision,
    goal:'仅验证真实DSH工具链的工作说明接续，不执行模型任务。',constraints:['合成验收，不使用真实用户资料'],acceptanceCriteria:['保留完整目标和限制'],
    mode:'host_assist',executor:'current_host',selectedOccurrenceIds:[],maxInputTokens:4000});
  assert.equal(prepared.run.executorOwner,'host:dsh-host');assert.equal(prepared.operation.executionStatus,'not_started');
  await fiber.dispose();assert.equal(ctx.tools.schemas().filter(x=>x.name.startsWith('mcp__synplex_workspace__')).length,0);
  assert.equal(readFileSync(tokenFile,'utf8'),credential.token);
  console.log(JSON.stringify({status:'passed',checks:['published Cordis loading','six real MCP tools','HTTP SQLite state','full goal prepare','current host only','unload removes tools'],modelCalls:0,
    limitation:'独立官方运行时验收，不是桌面安装或模型自主选工具验收。'}));
}finally{await ctx.fiber.dispose();await app.close();repository.close();rmSync(dir,{recursive:true,force:true});}
