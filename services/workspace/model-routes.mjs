import {PROTOCOL_VERSION} from '../../packages/contracts/validate.mjs';
import {modelFailure} from './model-contract.mjs';

const actions={'/api/v1/ui_models':'list','/api/v1/ui_save_model':'save','/api/v1/ui_change_model':'change','/api/v1/ui_discover_models':'discover','/api/v1/ui_probe_model':'probe'};
export async function handleModelRoute({path,auth,input,repository,modelAdmin}){
  if(!Object.hasOwn(actions,path))return null;
  if(auth.kind!=='ui'||input.protocolVersion!==PROTOCOL_VERSION)throw modelFailure('没有这项操作的权限。','请重新连接自己的工作台。','scope_denied');
  const body=await repository.modelOperation(auth,input,actions[path],{admin:!!modelAdmin?.(auth)});
  return {body};
}
