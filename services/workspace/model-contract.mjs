import {validateModelPricing,connectionPrice} from './model-pricing.mjs';
import {ProtocolError} from '../../packages/contracts/validate.mjs';

export const modelFailure=(message,nextAction='请检查模型设置后再试。',code='validation_failed')=>new ProtocolError(code,message,nextAction,'after_input');
export function exactObject(value,keys){
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw modelFailure('模型设置中有无法识别的内容。');
}
const text=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
export function validateEndpoint(value){
  if(!text(value,2048))throw modelFailure('请填写完整的模型服务地址。');
  let url;try{url=new URL(value);}catch{throw modelFailure('模型服务地址无法识别。');}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.port&&url.port!=='443')throw modelFailure('模型服务地址需要使用安全连接，且不能包含登录信息或附加参数。');
  if(!url.hostname.includes('.')||url.hostname.endsWith('.')||url.pathname.includes('%')||url.pathname.includes('//'))throw modelFailure('请填写公开的模型服务地址。');
  return url.href.replace(/\/+$/,'');
}
function capabilities(value){
  exactObject(value,['tools','stream','efforts','contextWindow']);
  if(typeof value.tools!=='boolean'||typeof value.stream!=='boolean'||!Array.isArray(value.efforts)||value.efforts.length>5)throw modelFailure('请核对型号的可用能力。');
  if(value.efforts.some(e=>!['none','low','medium','high','xhigh','max'].includes(e))||new Set(value.efforts).size!==value.efforts.length)throw modelFailure('思考程度设置不正确。');
  if(!Number.isSafeInteger(value.contextWindow)||value.contextWindow<1024||value.contextWindow>2_000_000)throw modelFailure('请填写型号的参考资料容量。');
  return {tools:value.tools,stream:value.stream,efforts:[...value.efforts],contextWindow:value.contextWindow};
}
function model(value){
  exactObject(value,['id','name','capabilities','pricing']);
  if(!text(value.id,160)||!text(value.name,80))throw modelFailure('请填写型号名称。');
  return {id:value.id.trim(),name:value.name.trim(),capabilities:capabilities(value.capabilities),...(value.pricing?{pricing:validateModelPricing(value.pricing)}:{})};
}
export function validateConnection(value){
  exactObject(value,['name','endpoint','protocol','models','maxOutputTokens']);
  if(!text(value.name,80)||!['chat-completions','responses'].includes(value.protocol))throw modelFailure('请填写名称并选择连接方式。');
  if(!Array.isArray(value.models)||!value.models.length||value.models.length>100)throw modelFailure('请添加至少一个可用型号，最多100个。');
  const models=value.models.map(model);
  if(new Set(models.map(m=>m.id)).size!==models.length)throw modelFailure('同一个型号请只添加一次。');
  if(!Number.isSafeInteger(value.maxOutputTokens)||value.maxOutputTokens<16||value.maxOutputTokens>32768)throw modelFailure('每次回复长度需在16至32768之间。');
  return {name:value.name.trim(),endpoint:validateEndpoint(value.endpoint),protocol:value.protocol,models,maxOutputTokens:value.maxOutputTokens};
}
export function validateSecret(secret){
  if(typeof secret!=='string'||secret.length<8||secret.length>4096||!/^[\x21-\x7e]+$/.test(secret))throw modelFailure('请填写有效的访问密钥，不要包含空格或换行。');
  return secret;
}
export function validateSelection(connection,selection,{tools=false}={}){
  exactObject(selection,['connectionId','model','effort']);
  const chosen=connection.models.find(m=>m.id===selection.model);
  if(!chosen||selection.connectionId!==connection.id||!connection.enabled)throw modelFailure('这个模型连接已变更或停用。','请选择当前可用的模型。','conflict');
  if(selection.effort!==null&&!chosen.capabilities.efforts.includes(selection.effort))throw modelFailure('该型号没有开放所选思考程度。');
  if(tools&&!chosen.capabilities.tools)throw modelFailure('该型号不能使用执行工具。','请选择可执行任务的型号。');
  return {connectionId:connection.id,revision:connection.revision,model:chosen.id,effort:selection.effort,protocol:connection.protocol,maxOutputTokens:connection.maxOutputTokens,capabilities:chosen.capabilities,...(chosen.pricing?{priceSnapshot:connectionPrice(connection.id,chosen)}:{})};
}
