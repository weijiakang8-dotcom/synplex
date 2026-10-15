import {ProtocolError} from '../../packages/contracts/validate.mjs';
import {MODEL_CONNECTION_MESSAGES} from '../../public/model-feedback.js';

export class ModelConnectionError extends ProtocolError{
 constructor(reason){
  if(!Object.hasOwn(MODEL_CONNECTION_MESSAGES,reason))throw new TypeError('Unknown model connection failure');
  super('capability_unavailable',MODEL_CONNECTION_MESSAGES[reason],'请检查模型连接设置，不需要连接其他执行工具。','after_input');
  this.reason=reason;
 }
}
export const modelConnectionFailure=reason=>new ModelConnectionError(reason);
export function safeModelConnectionError(error,operationId){
 if(!(error instanceof ModelConnectionError)||!Object.hasOwn(MODEL_CONNECTION_MESSAGES,error.reason))return null;
 return {code:'capability_unavailable',message:MODEL_CONNECTION_MESSAGES[error.reason],nextAction:'请检查模型连接设置，不需要连接其他执行工具。',retry:'after_input',operationId};
}
