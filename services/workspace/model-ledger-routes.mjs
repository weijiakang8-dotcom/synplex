import {exactObject,modelFailure} from './model-contract.mjs';
import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
export function handleModelLedgerRoute({path,auth,input,modelRelay}){
 if(path!=='/api/v1/ui_review_model_calls')return null;
 exactObject(input,['protocolVersion','scope','operationId','confirmed']);
 if(!modelRelay||auth.kind!=='ui'||input.protocolVersion!==PROTOCOL_VERSION||input.confirmed!==true||typeof input.operationId!=='string')throw modelFailure('请先核对原任务与服务商的请求记录。');
 return {body:modelRelay.review(auth,input.scope,input.operationId)};
}
