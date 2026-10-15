import {lstatSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {resolve,join,sep,isAbsolute} from 'node:path';
import {createCodexExecutor} from '../../adapters/execution/codex.mjs';
import {createAgentHubExecutor} from '../../adapters/execution/agenthub.mjs';
import {assertWorkspaceAdmission} from '../../scripts/runtime/handoff-state.mjs';

// Operator startup configuration only. Neither UI input nor memory can load
// executable modules, choose arbitrary endpoints, or borrow an active host home.
function readExecutorConfiguration(dataDir){
 assertWorkspaceAdmission(dataDir);
 const recovery=join(dataDir,'recovery.json');if(existsSync(recovery)&&JSON.parse(readFileSync(recovery,'utf8')).executorsEnabled!==true)return null;
 const file=join(dataDir,'executors.json');if(!existsSync(file))return null;
 const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('Executor configuration must be an owner-only regular file');
 const config=JSON.parse(readFileSync(file,'utf8'));if(!config||Array.isArray(config)||Object.keys(config).some(k=>!['codex','synplex'].includes(k)))throw new Error('Unsupported configured executor');
 return config;
}
export function loadExecutors(dataDir){
 const config=readExecutorConfiguration(dataDir);if(!config)return {};
 const adapters={};
 if(config.codex){
  const c=config.codex;if(Object.keys(c).some(k=>!['binary','home','model','provider','effort','allowedModels','gatewayEndpoint'].includes(k))||!isAbsolute(c.home??'')||!resolve(c.home).startsWith(resolve(dataDir)+sep)||lstatSync(c.home).isSymbolicLink())throw new Error('Codex must use its own isolated home under this data directory');
  if(!realpathSync(c.home).startsWith(realpathSync(dataDir)+sep))throw new Error('Executor home cannot escape through a parent symlink');
  adapters.codex=createCodexExecutor({...c,dataDir:join(dataDir,'executors','codex')});
 }
 if(config.synplex){
  const c=config.synplex;if(Object.keys(c).some(k=>!['endpoint','tokenFile','workflowId','requireWorkerReceipt','model','provider','effort','allowedModels'].includes(k))||!['endpoint','tokenFile','workflowId'].every(k=>typeof c[k]==='string')||c.requireWorkerReceipt!==undefined&&typeof c.requireWorkerReceipt!=='boolean')throw new Error('AgentHub needs one configured authenticated workflow');
  adapters.synplex=createAgentHubExecutor({...c,dataDir:join(dataDir,'executors','agenthub')});
 }
 return adapters;
}
