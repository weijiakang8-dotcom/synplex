import {OUTPUT_LIMIT_NOTICE} from '../../services/workspace/model-contract.mjs';
import {createAgentHubExecutor} from './agenthub.mjs';

// The existing engine adapter still owns approval, submissions, reconciliation,
// files and terminal receipts. This layer only binds a private model grant.
export function createModelConnectionExecutor({relay,relayEndpoint,...config}){
  const delegate=(choice,binding=null)=>createAgentHubExecutor({...config,model:choice.model,provider:choice.provider,effort:choice.effort,allowedModels:[{id:choice.model,label:'所选模型',provider:choice.provider,efforts:[choice.effort]}],modelBinding:binding?()=>binding:()=>null});
  const stored=input=>({model:input.packet?.executionOptions?.model??'lookup-only',provider:'synplex-run:'+input.operationId,effort:input.packet?.executionOptions?.effort??'default'});
  const fallback=()=>createAgentHubExecutor(config);
  const finish=(context,id,receipt)=>{if(receipt&&context){const limited=relay.calls(context.auth,context.scope,id).some(c=>c.truncated);receipt={...receipt,result:{...receipt.result,...(limited?{summary:receipt.result.summary+'\n\n'+OUTPUT_LIMIT_NOTICE}:{}),usage:relay.usage(context.auth,context.scope,id)}};relay.finish(context.auth,context.scope,id);}return receipt;};
  return {mode:'platform_owned',fileInputs:true,sourceFiles:true,
    getSelectionChoices:(auth,scope)=>auth?relay.choices(auth,scope):[],
    validateSelection:(options,context)=>relay.validate(context.auth,context.scope,options),
    preflight:input=>{relay.validate(input.authorization.auth,input.authorization.scope,input.packet.executionOptions);return delegate({model:input.packet.executionOptions.model,provider:'synplex-run:preview',effort:input.packet.executionOptions.effort}).preflight(input);},
    async execute(input){
      const context=input.authorization,binding=relay.grant(context.auth,context.scope,{operationId:input.operationId,attemptId:input.attemptId,options:input.packet.executionOptions,endpoint:relayEndpoint});
      const receipt=await delegate(stored(input),binding).execute(input);return finish(context,input.operationId,receipt);
    },
    async lookup(input){const receipt=await fallback().lookup(input);return finish(input.authorization,input.operationId,receipt);},
    inspectSubmission:input=>fallback().inspectSubmission(input),
    inspectInputDelivery:input=>fallback().inspectInputDelivery(input),
    inspectPendingInput:input=>fallback().inspectPendingInput(input),
    async resumeObservation(input){const receipt=await fallback().resumeObservation(input);return finish(input.authorization,input.operationId,receipt);},
    cancel:input=>fallback().cancel(input),
  };
}
