import { ProtocolError, payloadHash } from '../../packages/contracts/validate.mjs';
import { validateExecutionRequest } from './execution-input.mjs';
import { RemoteSubmissionGuard } from './remote-submission.mjs';
import { ExecutionSlots } from './execution-slots.mjs';
import { setTimeout as delay } from 'node:timers/promises';

// Internal, explicit execution owner. The six MCP tools never call this coordinator.
// Adapters are trusted startup configuration, never names/URLs supplied by source material.
export class ExecutionCoordinator {
  #adapters;
  #slots=new ExecutionSlots();
  #jobs=new Map();
  #active=new Map();
  #closed=false;
  constructor({repository,adapters={},timeoutMs=300_000,inputTimeoutMs=1_800_000,leaseMs=30_000}) {
    if(!Number.isInteger(timeoutMs)||timeoutMs<1||!Number.isInteger(leaseMs)||leaseMs<10||leaseMs>300_000)throw new TypeError('Invalid execution timing');
    if(!Number.isInteger(inputTimeoutMs)||inputTimeoutMs<1||inputTimeoutMs>86_400_000)throw new TypeError('Invalid input wait');
    this.repository=repository;this.timeoutMs=timeoutMs;this.inputTimeoutMs=inputTimeoutMs;this.leaseMs=leaseMs;
    this.#adapters=new Map();
    for(const [owner,adapter] of Object.entries(adapters)) {
      if(!['synplex','codex','dsh'].includes(owner)||!['platform_owned','delegated'].includes(adapter?.mode)||typeof adapter.execute!=='function')throw new TypeError('Invalid configured executor');
      this.#adapters.set(owner,Object.freeze({...adapter}));
    }
  }
  acquireModelSlot(signal){return this.#slots.acquire(signal);}
  executors(auth=null,scope=null) {return [...this.#adapters].map(([owner,a])=>({owner,mode:a.mode,cancellation:typeof a.cancel==='function',selectionChoices:a.getSelectionChoices?.(auth,scope)??a.selectionChoices??[],inputRecovery:typeof a.inspectPendingInput==='function'&&typeof a.resumeObservation==='function'}));}
  async start(auth,input) {
    validateExecutionRequest(input,true);
    if(this.#closed)throw new ProtocolError('capability_unavailable','执行服务正在关闭。','查询已有操作，稍后继续。','lookup_operation');
    // Permission is rechecked even on replay, while revision is deliberately ignored for an exact replay.
    const prior=this.repository.lookupMutation(auth,input.scope,'execute_task',{...input,expectedStateRevision:0},
      {requestId:input.requestId,expectedStateRevision:input.expectedStateRevision},'execute');
    if(auth.kind!=='ui')throw new ProtocolError('scope_denied','执行必须来自获准的操作入口。','插件继续帮助当前宿主，不启动第二个执行器。','never');
    if(prior){
      const state=this.repository.executionState(auth,input.scope,prior.operationId);
      // An explicit replay can resume an intent proven unsent (queued), using its original ID.
      // running/unknown/completed are never dispatched again, including after a service restart.
      if(state.operation.status==='queued'){
        const adapter=this.#adapters.get(state.run.executorOwner);
        if(!adapter||adapter.mode!==state.run.mode)throw new ProtocolError('capability_unavailable','所选执行工具尚未接通。','连接原执行工具，再接续已有操作。','after_input');
        const packet=this.repository.read(auth,input.scope,'context',state.run.contextPacketId,'execute');
        this.#validateSelection(adapter,packet,{auth,scope:input.scope});
        const files=this.#inputFiles(auth,input.scope,adapter,packet);
        if(typeof adapter.preflight==='function')await adapter.preflight({packet,authorization:{auth,scope:input.scope},sourceFiles:files.filter(f=>f.sourceId)});
        this.#schedule(auth,input.scope,prior.operationId);
      }
      return state;
    }
    const run=this.repository.read(auth,input.scope,'run',input.runId),adapter=this.#adapters.get(run?.executorOwner);
    if(!adapter || adapter.mode!==run.mode)throw new ProtocolError('capability_unavailable','所选执行工具尚未接通。','连接对应执行工具；准备的工作说明仍保留。','after_input');
    const packet=this.repository.read(auth,input.scope,'context',run.contextPacketId,'execute');
    this.#validateSelection(adapter,packet,{auth,scope:input.scope});
    const files=this.#inputFiles(auth,input.scope,adapter,packet);
    if(typeof adapter.preflight==='function')await adapter.preflight({packet,authorization:{auth,scope:input.scope},sourceFiles:files.filter(f=>f.sourceId)}); // Known unavailable transport must not create a paid/unknown attempt.
    const admitted=this.repository.admitExecution(auth,input);
    this.#schedule(auth,input.scope,admitted.operationId);
    return this.repository.executionState(auth,input.scope,admitted.operationId);
  }
  #validateSelection(adapter,packet,context){
    if(packet.taskInputs?.some(x=>x.artifacts.length)&&!adapter.fileInputs)throw new ProtocolError('capability_unavailable','这个工具暂时不能读取前一步的完整文件。','选择可以读取文件的执行工具；上一版成果仍保留，本次没有开工。','after_input');
    if(packet.executionOptions&&!adapter.validateSelection)throw new ProtocolError('capability_unavailable','这个工具还不能从这里选择型号。','使用工具自身的设置，或选择可以指定型号的工具。','after_input');
    adapter.validateSelection?.(packet.executionOptions,context);
  }
  #inputFiles(auth,scope,adapter,packet){
    const files=[...this.repository.taskInputFiles(auth,scope,packet),...(adapter.sourceFiles?this.repository.selectedSourceFiles(auth,scope,packet):[])];
    if(files.length>30||files.reduce((n,f)=>n+f.bytes.length,0)>64*1024*1024)throw new ProtocolError('budget_exceeded','本次原资料和前版成果合计超过文件容量。','减少选中的资料或前置成果，已有文件仍保留，没有另开任务。','after_input');
    return files;
  }
  #schedule(auth,scope,id,recovery=null) {
    if(this.#jobs.has(id))return;
    const job=this.#run(auth,scope,id,recovery).finally(()=>this.#jobs.delete(id));
    this.#jobs.set(id,job);job.catch(()=>{});
  }
  async #run(auth,scope,id,recovery) {
    const releaseSlot=await this.#slots.acquire();
    let claimed;
    try{claimed=recovery?this.repository.claimPausedExecution(auth,scope,id,recovery.prompt,this.leaseMs):this.repository.claimExecution(auth,scope,id,this.leaseMs);}
    catch(error){releaseSlot();throw error;}
    if(!claimed){releaseSlot();return;}
    const adapter=this.#adapters.get(claimed.executorOwner),controller=new AbortController();
    const active={auth,scope,claimed,adapter,controller,waiters:new Map(),releaseSlot};this.#active.set(id,active);
    let timer,heartbeat;
    const unknown=()=>{try{this.repository.markExecutionUnknown(auth,scope,id,claimed.claimId);}catch{}controller.abort();};
    try {
      if(!adapter || adapter.mode!==claimed.mode){unknown();return;}
      heartbeat=setInterval(()=>{
        try{if(!this.repository.heartbeatExecution(auth,scope,id,claimed.claimId,this.leaseMs))unknown();}
        catch{unknown();}
      },Math.max(1,Math.floor(this.leaseMs/3)));
      let arm;
      const timeout=new Promise(resolve=>{arm=duration=>{clearTimeout(timer);timer=setTimeout(()=>{unknown();resolve();},duration);};arm(this.timeoutMs);});
      // Preserve a late real receipt after a timeout. Never turn a network error into a fake failed result.
      const dispatch=recovery?adapter.resumeObservation:adapter.execute;
      const work=Promise.resolve().then(()=>dispatch(Object.freeze({operationId:id,attemptId:claimed.attemptId,
        idempotencyKey:id,authorization:{auth,scope},packet:structuredClone(claimed.packet),signal:controller.signal,
        inputFiles:this.#inputFiles(auth,scope,adapter,claimed.packet),
        remoteGuard:configuration=>new RemoteSubmissionGuard({repository:this.repository,auth,scope,...configuration}),
        requestInput:async prompt=>{
          if(active.waiters.size)throw new ProtocolError('conflict','已有一个问题等待回答。','先回答当前问题。');
          const q=this.repository.saveExecutionQuestion(auth,scope,id,claimed.claimId,prompt,new Date(Date.now()+this.inputTimeoutMs).toISOString());
          if(q.status!=='pending')throw new ProtocolError('conflict','问题已处理，不重复发送答案。','核对原任务。');
          arm(this.inputTimeoutMs);
          active.releaseSlot();
          const answer=await new Promise(resolve=>active.waiters.set(q.id,{q,resolve:answer=>{active.waiters.delete(q.id);resolve(answer);}}));
          if(answer===null)return null;
          while(true){
            const release=await this.#slots.acquire(controller.signal);
            if(controller.signal.aborted){release();throw controller.signal.reason;}
            try{
              if(this.repository.resumeExecutionInput(auth,scope,id,claimed.claimId)){active.releaseSlot=release;break;}
            }catch(error){release();throw error;}
            release();await delay(50,undefined,{signal:controller.signal});
          }
          arm(this.timeoutMs);return answer;
        },
        releaseInput:remoteRequestId=>{
          for(const [questionId,w] of active.waiters)if(w.q.prompt.remoteRequestId===String(remoteRequestId)){
            this.repository.finishExecutionQuestion(auth,scope,questionId,'unavailable');w.resolve(null);
          }
        },
        inputDelivered:questionId=>this.repository.finishExecutionQuestion(auth,scope,questionId,'sent'),
        inputUnavailable:questionId=>this.repository.finishExecutionQuestion(auth,scope,questionId,'unavailable'),
        report:event=>this.repository.appendExecutionActivity(auth,scope,id,claimed.claimId,event)}))).then(receipt=>{
          this.repository.saveExecutionReceipt(auth,scope,id,claimed.claimId,receipt);
          try{this.#writeback(auth,scope,id,receipt);}catch{ /* Durable receipt is pending; recovery only writes it back. */ }
        },()=>unknown()).catch(()=>unknown());
      await Promise.race([work,timeout]);
    }finally{
      for(const [questionId,w] of active.waiters){try{this.repository.finishExecutionQuestion(auth,scope,questionId,'unavailable');}catch{}w.resolve(null);}
      clearTimeout(timer);clearInterval(heartbeat);controller.abort();active.releaseSlot();this.#active.delete(id);
    }
  }
  async answer(auth,input){
    if(auth.kind!=='ui')throw new ProtocolError('scope_denied','请在自己的项目中回答。','使用获准的入口。');
    const prior=this.repository.lookupMutation(auth,input.scope,'answer_execution_question',input,
      {requestId:input.requestId,expectedStateRevision:input.expectedStateRevision},'execute');
    if(prior)return prior;
    const q=this.repository.read(auth,input.scope,'execution_question',input.questionId,'execute'),active=q&&this.#active.get(q.operationId),waiter=active?.waiters.get(q.id);
    if(!waiter||payloadHash(active.scope)!==payloadHash(input.scope))throw new ProtocolError('conflict','原提问连接已失效，答案尚未发送。','核对原任务，不能用新任务替代继续。','lookup_operation');
    const saved=this.repository.answerExecutionQuestion(auth,input);
    waiter.resolve({questionId:q.id,answers:saved.value.answers});return saved;
  }
  async reconnectInput(auth,input){
    if(!input||Object.keys(input).sort().join(',')!=='operationId,protocolVersion,scope'||input.protocolVersion!=='synplex.workspace/1.0.0'||typeof input.operationId!=='string')throw new ProtocolError('validation_failed','原任务信息不完整。','从原任务选择继续回答。');
    const {scope,operationId:id}=input,state=this.repository.executionState(auth,scope,id);
    if(auth.kind!=='ui'||!auth.capabilities.has('execute'))throw new ProtocolError('scope_denied','不能接续这个任务。','使用原项目的操作入口。');
    if(this.#closed)throw new ProtocolError('capability_unavailable','工作台正在关闭。','稍后回到原任务继续回答。');
    if(this.#jobs.has(id))return state;
    const adapter=this.#adapters.get(state.run.executorOwner);
    if(!adapter?.inspectPendingInput||!adapter.resumeObservation)throw new ProtocolError('capability_unavailable','这个工具还不能恢复原提问连接。','请在原工具核对任务，不重新提交；已保存内容仍保留。','lookup_operation');
    const prompt=await adapter.inspectPendingInput({operationId:id,attemptId:state.attempt.id});
    if(!prompt)throw new ProtocolError('conflict','原工具已不再等待这个答案。','核对原任务进度，不重新开始。','lookup_operation');
    this.#schedule(auth,scope,id,{prompt});await Promise.resolve();
    return this.repository.executionState(auth,scope,id);
  }
  #writeback(auth,scope,id,receipt){
    const state=this.repository.flushExecutionReceipt(auth,scope,id);
    for(const file of receipt.files??[]){
      const artifact=receipt.result.artifacts.find(a=>a.id===file.artifactId);
      if(!artifact)throw new ProtocolError('conflict','成果与回执不一致。','核对原文件，不重新执行。');
      this.repository.saveArtifactFile(auth,scope,state.operation.resultId,artifact,file.bytes);
    }
    return this.repository.executionState(auth,scope,id);
  }
  async reconcile(auth,scope,id){
    const state=this.repository.executionState(auth,scope,id);
    if(auth.kind!=='ui'||!auth.capabilities.has('execute'))throw new ProtocolError('scope_denied','无权核对执行。','使用原项目的执行入口。');
    const job=this.repository.read(auth,scope,'execution_job',id),adapter=this.#adapters.get(job.executorOwner);
    await this.#reconcileInputDeliveries(auth,scope,id,state,job,adapter);
    if(job.receiptId){this.repository.flushExecutionReceipt(auth,scope,id);}
    if(typeof adapter?.lookup!=='function'){
      if(['running','unknown'].includes(state.operation.status))throw new ProtocolError('capability_unavailable','这个执行工具还不能核对原任务。','原记录已保留，请核对工具自己的任务记录；不要再次提交。','lookup_operation');
      return this.repository.executionState(auth,scope,id);
    }
    // Lookup is a read-only host operation. It must never start/resume a model turn.
    let remoteSubmission=this.repository.read(auth,scope,'remote_submission',id);
    if(remoteSubmission?.taskId===null&&typeof adapter.inspectSubmission==='function'){
      const identified=await adapter.inspectSubmission({operationId:id,attemptId:job.attemptId,remoteSubmission});
      if(identified)this.repository.bindRemoteTask(auth,scope,id,job.attemptId,identified.taskId);
      remoteSubmission=this.repository.read(auth,scope,'remote_submission',id);
    }
    const receipt=await adapter.lookup({authorization:{auth,scope},operationId:id,attemptId:job.attemptId,remoteSubmission});
    if(receipt){
      if(!job.receiptId)this.repository.saveExecutionReceipt(auth,scope,id,job.claimId,receipt);
      this.#writeback(auth,scope,id,receipt);
    }
    return this.repository.executionState(auth,scope,id);
  }
  async #reconcileInputDeliveries(auth,scope,id,state,job,adapter){
    if(typeof adapter?.inspectInputDelivery!=='function')return;
    for(const question of state.questions){
      if(question.status!=='answered'||question.delivery==='sent')continue;
      const sent=await adapter.inspectInputDelivery({operationId:id,attemptId:job.attemptId,question});
      if(sent)this.repository.finishExecutionQuestion(auth,scope,question.id,'sent');
    }
  }
  async cancel(auth,scope,id) {
    const state=this.repository.requestExecutionCancellation(auth,scope,id),active=this.#active.get(id);
    if(active && this.repository.takeExecutionCancellation(active.auth,scope,id,active.claimed.claimId)) {
      // Sending a cancellation request does not prove the remote task stopped.
      if(typeof active.adapter?.cancel==='function') {
        try{await active.adapter.cancel({operationId:id,attemptId:active.claimed.attemptId,signal:active.controller.signal});}
        catch{this.repository.markExecutionUnknown(active.auth,scope,id,active.claimed.claimId);}
      }else{this.repository.markExecutionUnknown(active.auth,scope,id,active.claimed.claimId);active.controller.abort();}
    }
    return active ? this.repository.executionState(auth,scope,id) : state;
  }
  async recover(auth,scope) {
    this.repository.recoverExpiredExecutions(auth,scope);
    // This path never schedules execution, even for a queued job. An operator can inspect the
    // unsent work; automatically dispatching on restart would cross the explicit-start boundary.
    for(const pending of this.repository.pendingOutbox(auth,scope))if(pending.kind==='execution_writeback') {
      this.repository.flushExecutionReceipt(auth,scope,pending.payload.operationId);
    }
  }
  async idle(){await Promise.allSettled([...this.#jobs.values()]);}
  async close(){this.#closed=true;await this.idle();}
}
