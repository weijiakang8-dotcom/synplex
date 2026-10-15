import {ProtocolError} from '../contracts/validate.mjs';
const invalid=()=>{throw new ProtocolError('capability_unavailable','这个模型或思考程度还不能用于所选工具。','选择已连接的型号；没有可用账号的型号不会自动替换。','after_input');};
export function selectionChoices({model,provider,effort,allowedModels=[]}){
  const rows=allowedModels.length?allowedModels:[{id:model,label:model,efforts:[effort],provider}];
  const ids=new Set();
  return rows.map(row=>{
    if(!row||typeof row.id!=='string'||!row.id||row.id.length>160||ids.has(row.id)||!Array.isArray(row.efforts)||!row.efforts.length||row.efforts.some(x=>typeof x!=='string'||!x||x.length>32))invalid();
    if(typeof (row.provider??provider)!=='string'||!(row.provider??provider))invalid();
    ids.add(row.id);return {id:row.id,label:row.label||row.id,efforts:[...new Set(row.efforts)],provider:row.provider??provider};
  });
}
export function selectExecution(options,choices,defaults){
  if(options===undefined)options={model:defaults.model,effort:defaults.effort};
  if(!options||Object.keys(options).sort().join(',')!=='effort,model')invalid();
  const row=choices.find(c=>c.id===options.model);
  if(!row||!row.efforts.includes(options.effort))invalid();
  return {model:row.id,effort:options.effort,provider:row.provider};
}
