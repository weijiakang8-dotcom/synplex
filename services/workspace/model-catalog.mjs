import {validateEndpoint,validateSecret} from './model-contract.mjs';
import {ModelConnectionError,modelConnectionFailure} from './model-error.mjs';

export async function fetchModelCatalog(transport,{endpoint,secret}){
 validateEndpoint(endpoint);validateSecret(secret);
 let value;
 try{
  const raw=await transport({endpoint:validateEndpoint(endpoint),path:'/models',secret,timeoutMs:15000,maxBytes:512*1024});
  value=JSON.parse(raw.toString('utf8'));
 }catch(error){throw error instanceof ModelConnectionError?error:modelConnectionFailure('response');}
 if(!Array.isArray(value?.data))throw modelConnectionFailure('response');
 const valid=value.data.map(m=>m?.id).filter(id=>typeof id==='string'&&id.trim().length>0&&id.length<=160&&!/[\x00-\x1f\x7f]/.test(id));
 const models=[...new Set(valid)].sort().slice(0,1000),partial=value.has_more===true||!!value.next_page||valid.length>1000;
 if(!models.length)throw modelConnectionFailure('empty');
 const capacities={};
 for(const row of value.data){
  if(!models.includes(row?.id)||!Number.isSafeInteger(row.context_window)||row.context_window<1024||row.context_window>2_000_000)continue;
  if(Object.hasOwn(capacities,row.id)){if(capacities[row.id]!==row.context_window)capacities[row.id]=null;}
  else Object.defineProperty(capacities,row.id,{value:row.context_window,writable:true,enumerable:true,configurable:true});
 }
 return {models,capacities,partial,notice:partial?'已取得部分型号，服务商还有后续列表；未列出的型号仍可手动填写。':'已取得这个账号开放的型号。服务商提供的资料容量会填入设置，保存后生效；工具和思考能力请按服务商说明核对。'};
}
