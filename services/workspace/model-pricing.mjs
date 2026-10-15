import {ProtocolError} from '../../packages/contracts/validate.mjs';
import {validatePrice,priceUsage} from '../../packages/execution/accounting.mjs';

const fields=['validFrom','validUntil','inputUsdPerMillion','cachedInputUsdPerMillion','outputUsdPerMillion','source'];
export function validateModelPricing(value){
 if(!value||Object.keys(value).sort().join(',')!==[...fields].sort().join(',')||typeof value.source!=='string'||/[\x00-\x1f\x7f]/.test(value.source))throw new ProtocolError('validation_failed','请核对单价、来源和生效日期。','不清楚单价时可以暂不填写。');
 const checked=validatePrice({...value,provider:'connection',model:'model'});
 return Object.fromEntries(fields.map(k=>[k,checked[k]]));
}
export function connectionPrice(connectionId,model){
 return model.pricing?validatePrice({...model.pricing,provider:'connection:'+connectionId,model:model.id}):null;
}
export function frozenCallAccounting(calls){
 const rows=calls.map(call=>{
  const usage={observationScope:'attempt',provider:'connection:'+call.selection.connectionId,model:call.selection.model,inputTokens:call.usage?.inputTokens??null,outputTokens:call.usage?.outputTokens??null,cachedInputTokens:call.usage?.cachedInputTokens??null,costUsd:null,pricingRevision:null,provenance:'provider_receipt'};
  return priceUsage(usage,call.priceSnapshot?[call.priceSnapshot]:[],call.startedAt);
 });
 return {usd:rows.length&&rows.every(r=>r.usd!==null)?rows.reduce((n,r)=>n+r.usd,0):null,pricingRevision:null,reason:rows.length&&rows.every(r=>r.usd!==null)?'frozen_request_prices':'usage_or_price_unknown'};
}
