export function modelCalculatedCost(usage,price,at){
 if(!usage||!price||Date.parse(at)<Date.parse(price.validFrom)||price.validUntil!==null&&Date.parse(at)>=Date.parse(price.validUntil))return null;
 const {inputTokens:input,outputTokens:output,cachedInputTokens:cache}=usage;
 if(![input,output,cache].every(n=>Number.isSafeInteger(n)&&n>=0)||cache>input)return null;
 return ((input-cache)*price.inputUsdPerMillion+cache*price.cachedInputUsdPerMillion+output*price.outputUsdPerMillion)/1e6;
}
export function modelCostText(usage,price,at){const value=modelCalculatedCost(usage,price,at);return value===null?'实际费用待账单确认':`按已保存单价计算 $${value.toFixed(6)}；实付待账单确认`;}
