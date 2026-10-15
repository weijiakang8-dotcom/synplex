import {existsSync,mkdirSync,readdirSync,writeFileSync,renameSync,readFileSync,lstatSync} from 'node:fs';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {initialConnection} from '../../services/workspace/initial-connection.mjs';
import {configureProduct,productConfiguration} from './product.mjs';
import {settings} from './workspace.mjs';
import {verifyEngineEnvironment} from './engine-environment.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
function run(python,args,log){
 const result=spawnSync(python,['-B',join(root,'integrations/agenthub/engine_runtime.py'),...args],{encoding:'utf8',timeout:90000,maxBuffer:1024*1024});
 writeFileSync(log,(result.stdout||'')+(result.stderr||''),{mode:0o600,flag:'a'});
 if(result.error||result.status!==0)throw new Error('独立执行环境准备未完成，请保留安装记录；没有覆盖原资料或再次提交任务。');
}
export async function installInstance({directory,environment,backend=join(root,'vendor/agenthub/backend'),pgBin,valkey,ports=[5200,5214,5216,5218]}){
 directory=resolve(directory);environment=resolve(environment);backend=resolve(backend);
 if(ports.length!==4||new Set(ports).size!==4||ports.some(p=>!Number.isInteger(p)||p<1024||p>65535))throw new Error('四个服务需要使用不同的可用地址。');
 const dataDir=join(directory,'workspace'),engineRoot=join(directory,'engine'),config=settings({dataDir,port:ports[0]}),python=join(environment,'bin/python');
 verifyEngineEnvironment(environment,backend);
 if(existsSync(directory)){
  const stat=lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||stat.mode&0o077)throw new Error('请选择仅本人使用的独立资料目录。');
  if(existsSync(join(directory,'install-incomplete.json')))throw new Error('上次安装没有完成，请先核对安装记录，不会覆盖或重新初始化。');
  if(existsSync(join(dataDir,'product-start.json'))){
   const current=productConfiguration(config);
   if(current.engineRoot!==engineRoot||current.python!==python||current.identity.backend!==backend||current.identity.apiPort!==ports[1]||current.identity.redisPort!==ports[2]||current.identity.databasePort!==ports[3])throw new Error('现有安装与所选设置不同，未覆盖。');
   return {existing:true,dataDir,modelCalls:0};
  }
  if(readdirSync(directory).length)throw new Error('完整安装需要空的新目录，已有资料请使用联合迁移流程。');
 }else mkdirSync(directory,{recursive:true,mode:0o700});
 writeFileSync(join(directory,'install-incomplete.json'),JSON.stringify({format:'synplex.full-install/1',ports,modelCalls:0}),{mode:0o600,flag:'wx'});
 const log=join(directory,'install.log');
 run(python,['setup','--root',engineRoot,'--backend',backend,'--postgres-bin',pgBin,'--valkey',valkey,'--api-port',String(ports[1]),'--redis-port',String(ports[2]),'--database-port',String(ports[3])],log);
 run(python,['configure-relay','--root',engineRoot,'--relay-endpoint',config.endpoint+'/internal/model/v1'],log);
 const repository=new WorkspaceRepository({dataDir});try{initialConnection(repository,config);}finally{repository.close();}
 const state=JSON.parse(readFileSync(join(engineRoot,'engine/bootstrap.json'),'utf8'));
 writeFileSync(join(dataDir,'executors.json'),JSON.stringify({synplex:{endpoint:`http://127.0.0.1:${ports[1]}`,tokenFile:join(engineRoot,'engine/access-token'),workflowId:state.workflow_id,requireWorkerReceipt:true,useModelConnections:true}}),{mode:0o600,flag:'wx'});
 await configureProduct(config,{engineRoot,python});
 renameSync(join(directory,'install-incomplete.json'),join(directory,'install-receipt.json'));
 return {existing:false,dataDir,modelCalls:0};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{
  const file=process.argv[2];if(!file)throw new Error('请提供独立安装的设置文件。');
  const stat=lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('安装设置文件必须仅本人可读。');
  console.log(JSON.stringify(await installInstance(JSON.parse(readFileSync(file,'utf8')))));
 }catch(error){console.error(error.message);process.exitCode=1;}
}
