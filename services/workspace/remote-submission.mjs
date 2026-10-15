import { ProtocolError, payloadHash } from '../../packages/contracts/validate.mjs';

const unknown = operationId => {
  const error = new ProtocolError('conflict', '执行提交的回执尚未核对，不能重复发送。',
    '保留原操作；已有远端任务编号时只查询原任务，没有编号时先核对执行服务的记录。', 'lookup_operation');
  error.operationId = operationId;
  return error;
};

// Service-configured transport, not a user/source-supplied URL. No automatic HTTP retry.
// This guard is internal: actual transport, polling, cancellation and artifact checks are separate.
export class RemoteSubmissionGuard {
  constructor({ repository, auth, scope, targetKey, transport }) {
    if(typeof targetKey!=='string'||!/^[a-f0-9]{64}$/.test(targetKey)||
        typeof transport?.submit!=='function'||typeof transport?.lookup!=='function')throw new TypeError('Explicit remote transport required');
    this.repository=repository;this.auth=auth;this.scope=structuredClone(scope);
    this.targetKey=targetKey;this.transport=Object.freeze({...transport});
  }
  async submitOrLookup({ operationId, attemptId, packet, payload, signal }) {
    if(signal?.aborted)throw unknown(operationId); // No reservation or network side effect.
    const immutablePacket=structuredClone(packet),immutablePayload=structuredClone(payload);
    const {contentHash,...content}=immutablePacket;
    if(contentHash!==payloadHash(content))throw new ProtocolError('conflict','提交背景的内容与指纹不一致。',
      '核对原工作说明，不发送改动后的背景。','lookup_operation');
    const reserved=this.repository.reserveRemoteSubmission(this.auth,this.scope,operationId,attemptId,
      {packetHash:immutablePacket.contentHash,payloadHash:payloadHash(immutablePayload),targetKey:this.targetKey});
    let taskId=reserved.submission.taskId;
    if(reserved.fresh){
      // Persist-before-send deliberately favors no duplicate charge over automatic recovery.
      // A crash here means submission is unknown, never a license to send a second POST.
      if(signal?.aborted)throw unknown(operationId);
      try {
        const response=await this.transport.submit({ operationId, attemptId,
          idempotencyKey:operationId, packet:immutablePacket, payload:immutablePayload, signal });
        taskId=response?.taskId;
        this.repository.bindRemoteTask(this.auth,this.scope,operationId,attemptId,taskId);
      }catch{throw unknown(operationId);} // Do not expose raw provider errors or secrets.
    }
    if(taskId===null)throw unknown(operationId);
    let snapshot;
    try{snapshot=await this.transport.lookup({taskId,signal});}catch{throw unknown(operationId);}
    if(!snapshot || snapshot.taskId!==taskId)throw unknown(operationId);
    return { operationId, attemptId, taskId, snapshot:structuredClone(snapshot) };
  }
}
