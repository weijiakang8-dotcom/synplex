// Complete deterministic bookkeeping via the actual repository transactions.
// It does not call an executor/model or certify the synthetic delivery content.
import {mkdirSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {WorkspaceRepository} from '../../services/workspace/repository.mjs';
import {payloadHash,sha256,PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';

export function seedIdleRecoveryWorkspace(dataDir,engineRoot,bootstrap,taskId,{relay=false}={}){
 const scope={projectId:'idle-recovery-fixture',versionId:null,branchId:null},repo=new WorkspaceRepository({dataDir});
 try{
  const caps=['read_memory','write_memory','review_memory','prepare_task','record_result','execute'];
  const ui=repo.createCredential({ownerId:'fixture-owner',actorId:'local-human',scope,kind:'ui',capabilities:caps});
  const agent=repo.createCredential({ownerId:'fixture-owner',actorId:'codex-host',scope,kind:'agent',capabilities:['read_memory','write_memory','prepare_task','record_result']});
  const uiTokenFile=join(dataDir,'ui-token'),agentTokenFile=join(dataDir,'agent-token');
  writeFileSync(uiTokenFile,ui.token,{mode:0o600});writeFileSync(agentTokenFile,agent.token,{mode:0o600});
  writeFileSync(join(dataDir,'connection.json'),JSON.stringify({endpoint:'http://127.0.0.1:5411',scope,uiTokenFile,agentTokenFile}),{flag:'wx',mode:0o600});
  const config={...(relay?{useModelConnections:true,requireWorkerReceipt:true}:{}),endpoint:`http://127.0.0.1:${bootstrap.api_port}`,workflowId:bootstrap.workflow_id,tokenFile:join(engineRoot,'engine/access-token')};
  writeFileSync(join(dataDir,'executors.json'),JSON.stringify({synplex:config}),{flag:'wx',mode:0o600});
  const auth=repo.authenticate(ui.token);
  if(relay){
   repo.models(auth,scope).save({requestId:'relay-model-fixture',config:{name:'恢复样本连接',endpoint:'https://api.example.com/v1',protocol:'chat-completions',maxOutputTokens:256,models:[{id:'fixture-model',name:'恢复型号',pricing:{validFrom:'2026-01-01T00:00:00Z',validUntil:null,inputUsdPerMillion:1,cachedInputUsdPerMillion:0.1,outputUsdPerMillion:2,source:'fixture-price'},capabilities:{tools:true,stream:false,efforts:[],contextWindow:32000}}]},secret:'synthetic-private-restore-key'});
   const chat=repo.chat(auth,scope),conversation=chat.create('restore-conversation');
   const request=chat.reserve({id:randomUUID(),conversationId:conversation.id,requestId:'restore-turn',inputHash:payloadHash('fixture-only'),content:'保留聊天历史',selection:{},excludedClaimIds:[],background:null});
   chat.update(request.value.id,{status:'completed',delta:'这是恢复夹具，不是真实模型回复。'});
  }
  const state=repo.state(auth,scope),goal='保留已完成的合成任务与成果';
  const input={protocolVersion:PROTOCOL_VERSION,scope,requestId:randomUUID(),expectedStateRevision:state.stateRevision,goal,constraints:['不调用模型'],acceptanceCriteria:['原任务和原文件保留'],mode:'platform_owned',executor:'synplex',selectedOccurrenceIds:[],maxInputTokens:2000};
  const packet={id:randomUUID(),protocolVersion:PROTOCOL_VERSION,scope,stateRevision:state.stateRevision,permissionRevision:state.permissionRevision,goal,constraints:input.constraints,acceptanceCriteria:input.acceptanceCriteria,facts:[],failures:[],lessons:[],candidates:[],conflicts:[],unknowns:[],evidence:[],selectedOccurrenceIds:[],coverage:'complete',budget:{maxInputTokens:2000,reservedTokens:100,estimatedTokens:300,estimatorVersion:'synthetic/1'},createdAt:new Date().toISOString()};
  packet.contentHash=payloadHash(packet);
  const prepared=repo.registerPrepared(auth,input,packet).value;
  const request={protocolVersion:PROTOCOL_VERSION,scope,requestId:randomUUID(),expectedStateRevision:repo.state(auth,scope).stateRevision,runId:prepared.run.id};
  const grant=repo.issueExecutionAuthorization(auth,request),admitted=repo.admitExecution(auth,{...request,authorizationId:grant.authorizationId});
  const id=admitted.operationId,claimed=repo.claimExecution(auth,scope,id),attemptId=claimed.attemptId;
  const binding={packetHash:packet.contentHash,payloadHash:payloadHash({fixture:true}),targetKey:payloadHash({endpoint:config.endpoint,workflowId:config.workflowId,tokenFile:config.tokenFile})};
  repo.reserveRemoteSubmission(auth,scope,id,attemptId,binding);repo.bindRemoteTask(auth,scope,id,attemptId,taskId);
  const bytes=Buffer.from('# 已保存的合成成果\n本样本不代表真实模型完成任务。'),artifact={id:randomUUID(),name:'合成成果.md',uri:'synplex-fixture:delivery',sha256:sha256(bytes),byteLength:bytes.length,mediaType:'text/markdown',verification:'reported'};
  repo.saveExecutionReceipt(auth,scope,id,claimed.claimId,{status:'succeeded',result:{eventId:'fixture:'+taskId,attemptId,provider:'synthetic-local-fixture',summary:'完整事务样本，不是模型结果。',artifacts:[artifact],checks:[],usage:{observationScope:'preparation_only',provider:null,model:null,inputTokens:0,outputTokens:0,cachedInputTokens:0,costUsd:0,pricingRevision:null,provenance:'no_model_call'},supersedesResultId:null,occurredAt:null}});
  const final=repo.flushExecutionReceipt(auth,scope,id);repo.saveArtifactFile(auth,scope,final.results[0].id,artifact,bytes);
  const journal={operationId:id,attemptId,taskId,targetKey:binding.targetKey,packetHash:binding.packetHash,payloadHash:binding.payloadHash};
  mkdirSync(join(dataDir,'executors/agenthub'),{recursive:true,mode:0o700});
  writeFileSync(join(dataDir,'executors/agenthub',id+'.json'),JSON.stringify(journal),{flag:'wx',mode:0o600});
  return {completed:journal,delivery:{resultId:final.results[0].id,artifactId:artifact.id,sha256:artifact.sha256,byteLength:bytes.length}};
 }finally{repo.close();}
}
