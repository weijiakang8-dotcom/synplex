// Deterministic bookkeeping fixture, not a claim that these tasks ran.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {payloadHash} from '../../packages/contracts/validate.mjs';

export function seedRecoveryWorkspace(dataDir,engineRoot,bootstrap,taskIds){
 const repo=new WorkspaceRepository({dataDir}),scope={projectId:'recovery-identity-fixture',versionId:null,branchId:null};
 const ui=repo.createCredential({ownerId:'fixture-owner',actorId:'human',scope,kind:'ui',capabilities:['read_memory','prepare_task','record_result']});
 const agent=repo.createCredential({ownerId:'fixture-owner',actorId:'host',scope,capabilities:['read_memory','prepare_task','record_result']});
 repo.close();
 const write=(path,value)=>writeFileSync(path,JSON.stringify(value),{mode:0o600,flag:'wx'});
 const uiTokenFile=join(dataDir,'ui-token'),agentTokenFile=join(dataDir,'agent-token');
 writeFileSync(uiTokenFile,ui.token,{mode:0o600});writeFileSync(agentTokenFile,agent.token,{mode:0o600});
 write(join(dataDir,'connection.json'),{scope,endpoint:'http://127.0.0.1:5411',uiTokenFile,agentTokenFile});
 const config={endpoint:`http://127.0.0.1:${bootstrap.api_port}`,workflowId:bootstrap.workflow_id,tokenFile:join(engineRoot,'engine/access-token')};
 write(join(dataDir,'executors.json'),{synplex:config});
 const targetKey=payloadHash({endpoint:config.endpoint,workflowId:config.workflowId,tokenFile:config.tokenFile}),ids={};
 const db=new DatabaseSync(join(dataDir,'workspace.sqlite'));
 try{
  const partition=db.prepare('SELECT partition FROM scopes LIMIT 1').get().partition;
  const put=(kind,body)=>db.prepare('INSERT INTO records(partition,kind,id,payload_hash,body_json) VALUES(?,?,?,?,?)').run(partition,kind,body.id,payloadHash(body),JSON.stringify(body));
  for(const [name,taskId] of Object.entries(taskIds)){
   const id=randomUUID(),attemptId=randomUUID(),packetId=randomUUID(),packet={id:packetId,goal:'固定身份核对夹具'};packet.contentHash=payloadHash(packet);
   const binding={packetHash:packet.contentHash,payloadHash:'b'.repeat(64),targetKey:name==='foreign'?'c'.repeat(64):targetKey};
   put('context',packet);put('execution_job',{id,packetId,attemptId});put('remote_submission',{id,attemptId,binding,taskId,recordedAt:null,identifiedAt:null});
   ids[name]={operationId:id,attemptId,taskId,targetKey:binding.targetKey,packetHash:binding.packetHash,payloadHash:binding.payloadHash};
  }
 }finally{db.close();}
 const journals=join(dataDir,'executors/agenthub');mkdirSync(journals,{recursive:true,mode:0o700});
 if(ids.completed)write(join(journals,ids.completed.operationId+'.json'),ids.completed);
 return ids;
}
