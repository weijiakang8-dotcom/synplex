const rates=[['inputUsdPerMillion','输入单价'],['cachedInputUsdPerMillion','缓存输入单价'],['outputUsdPerMillion','输出单价']];
export function modelPriceEditor(price,esc){
 return `<details><summary>费用设置（选填）</summary><label class="check"><input type="checkbox" name="priceEnabled" ${price?'checked':''}>填写我实际支付的单价</label><p class="subtle">单位为美元／百万计费单位。请按自己账号的账单填写；中转服务的价格可能与官方不同。不填写不影响使用，费用会显示待确认。</p>${rates.map(([key,label])=>`<label>${label}<input type="number" name="price:${key}" min="0" step="any" value="${esc(price?.[key]??'')}"></label>`).join('')}<label>价格来源<input name="price:source" maxlength="512" value="${esc(price?.source??'')}" placeholder="例如：服务商价格页或我的套餐说明"></label><label>生效时间<input type="datetime-local" name="price:validFrom" value="${esc(localDate(price?.validFrom))}"></label><label>结束时间（可留空）<input type="datetime-local" name="price:validUntil" value="${esc(localDate(price?.validUntil))}"></label></details>`;
}
function localDate(value){if(!value)return '';const date=new Date(value);return new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,16);}
export function readModelPrice(row){
 if(!row.querySelector('[name=priceEnabled]').checked)return {};
 const value=key=>row.querySelector(`[name="price:${key}"]`).value;
 const number=key=>value(key)===''?NaN:Number(value(key));
 if(rates.some(([key])=>!Number.isFinite(number(key)))||!value('validFrom')||!value('source').trim())throw Error('请填写完整单价、价格来源和生效时间；也可取消费用设置。');
 return {pricing:{...Object.fromEntries(rates.map(([key])=>[key,number(key)])),source:value('source').trim(),validFrom:new Date(value('validFrom')).toISOString(),validUntil:value('validUntil')?new Date(value('validUntil')).toISOString():null}};
}
