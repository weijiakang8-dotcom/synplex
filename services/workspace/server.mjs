import {publicAccessOptions,buildInformation} from './public-access.mjs';
import {createDiagnosticLog} from './diagnostics.mjs';
import { existsSync, mkdirSync, readFileSync, writeFileSync, lstatSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceRepository } from './repository.mjs';
import { createWorkspaceServer } from './http.mjs';
import { LocalProjects } from './local-projects.mjs';
import { ExecutionCoordinator } from './execution.mjs';
import { loadExecutors } from './executors.mjs';
import { validateWire, payloadHash } from '../../packages/contracts/validate.mjs';
import {writeUiLauncher} from './ui-launch.mjs';
import {verifyRelease} from '../../scripts/runtime/release.mjs';
import {acquireWorkspaceLease} from '../../scripts/runtime/workspace-lease.mjs';
import {assertWorkspaceAdmission} from '../../scripts/runtime/handoff-state.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(existsSync(join(root,'release-incomplete.json')))throw new Error('发行文件尚未打包完成，请保留当前版本并核对。');
if(existsSync(join(root,'release.json')))verifyRelease(root);
const dataDir=resolve(process.env.SYNPLEX_WORKSPACE_DATA_DIR??join(root,'.runtime','workspace'));
if(['snapshot.json','backup-incomplete.json','restore-incomplete.json'].some(name=>existsSync(join(dataDir,name))))throw new Error('这是备份或未完成的恢复目录，不能直接启动；请先完成恢复核对。');
const port=Number(process.env.SYNPLEX_WORKSPACE_PORT??5200);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('请为工作台设置可用的独立连接地址。');
const scope=validateWire('Scope',JSON.parse(process.env.SYNPLEX_WORKSPACE_SCOPE??'{"projectId":"local-project","versionId":null,"branchId":null}'));
// Hold before the repository or local configuration can write. Direct starts
// use the same gate as supervised starts, backup and original-state checks.
const workspaceLease=acquireWorkspaceLease(dataDir,{create:true});
process.once('exit',()=>workspaceLease.close());
assertWorkspaceAdmission(dataDir);
const repository=new WorkspaceRepository({dataDir});
const connectionFile=join(dataDir,'connection.json');
let connection;
if(existsSync(connectionFile)) {
  if(lstatSync(connectionFile).isSymbolicLink())throw new Error('请使用真实的连接文件，不能使用文件替身。');
  connection=JSON.parse(readFileSync(connectionFile,'utf8'));
  if(payloadHash(connection.scope)!==payloadHash(scope))throw new Error('已有资料属于其他项目，请为新项目选择独立的资料文件夹。');
}else{
  const capabilities=['read_memory','write_memory','prepare_task','record_result'];
  const ui=repository.createCredential({ownerId:'local-owner',actorId:'local-human',scope,capabilities:[...capabilities,'review_memory'],kind:'ui'});
  const agent=repository.createCredential({ownerId:'local-owner',actorId:'codex-host',scope,capabilities,kind:'agent'});
  const credentialDir=join(dataDir,'connections');mkdirSync(credentialDir,{mode:0o700});
  const uiTokenFile=join(credentialDir,'ui-token'),agentTokenFile=join(credentialDir,'codex-token');
  writeFileSync(uiTokenFile,ui.token,{flag:'wx',mode:0o600});writeFileSync(agentTokenFile,agent.token,{flag:'wx',mode:0o600});
  connection={endpoint:`http://127.0.0.1:${port}`,scope,uiTokenFile,agentTokenFile};
  writeFileSync(connectionFile,JSON.stringify(connection,null,2),{flag:'wx',mode:0o600});
}
if(connection.endpoint!==`http://127.0.0.1:${port}`)throw new Error('已有连接使用不同的地址，请先核对设置，不要自动更改。');
const modules={};
for(const name of ['ingestion','context','experience']) {
  const moduleFile=join(root,'packages',name,'index.mjs');
  // Only frozen, integrated workspace code is loaded. Never import the other live worktree.
  if(existsSync(moduleFile))modules[name]=await import(fileURLToPath(new URL(`../../packages/${name}/index.mjs`,import.meta.url)));
}
const rootAuth=repository.authenticate(readFileSync(connection.uiTokenFile,'utf8').trim());
const adapters=loadExecutors(dataDir),execution=new ExecutionCoordinator({repository,adapters});
const localProjects=process.env.SYNPLEX_WORKSPACE_SERVE_UI==='1'?new LocalProjects({repository,dataDir,connection,rootAuth,allowExecution:!!execution.executors().length}):null;
const diagnostics=createDiagnosticLog(dataDir);
const app=createWorkspaceServer({repository,modules,localProjects,execution,diagnostics,...publicAccessOptions(),...buildInformation(),publicDir:process.env.SYNPLEX_WORKSPACE_SERVE_UI==='1'?join(root,'public'):null});
let stopping=false;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{if(stopping)return;stopping=true;await app.close();repository.close();process.exit(0);});
try{
  const url=await app.listen(port);
  const worker=rootAuth;
  if(localProjects){
    for(const p of await localProjects.list(worker)){
      const selected=await localProjects.select(worker,p.scope);
      await app.service.recoverImports(selected.auth,p.scope);
      if(selected.auth.capabilities.has('execute'))await execution.recover(selected.auth,p.scope);
    }
  }else await app.service.recoverImports(worker,scope);
  let launchFile=null;
  if(process.env.SYNPLEX_WORKSPACE_SERVE_UI==='1'){
    const selected=await localProjects.select(worker,scope);
    launchFile=writeUiLauncher(dataDir,await app.createUiPairing(selected.auth,scope,worker));
  }
  console.log(JSON.stringify({url,connectionFile,launchFile,capabilities:app.capabilities(),notice:'工作台仅在这台电脑上运行。工具连接成功不代表任务完成；费用只记录实际获得的数字。'}));
}catch(error){repository.close();throw error;}
