import {modelCostText} from './model-cost.js';
const labels={running:'等待回复',completed:'已收到回复',unknown:'需核对',reviewed:'已保留待核对记录'};
export function executionModelUsage(calls,operation,esc){
 if(!calls?.length)return '';
 const unknown=calls.some(c=>c.status==='unknown'),ended=['succeeded','failed','cancelled'].includes(operation.status);
 return `<details class="usage-details"><summary>模型请求 · ${calls.length} 次</summary>${calls.map(c=>`<section><p>${esc(c.selection.model)} · ${labels[c.status]||'需核对'}</p><p class="subtle">输入 ${c.usage?.inputTokens??'未知'} · 输出 ${c.usage?.outputTokens??'未知'} · ${esc(modelCostText(c.usage,c.priceSnapshot,c.startedAt))}</p>${c.truncated?'<p class="notice">回复长度不足，内容或文件尚未完成。请到模型设置调高回复长度，再继续原任务。</p>':''}${c.providerReceipt?`<details><summary>账单查找依据</summary><p>${esc(c.providerReceipt)}</p></details>`:''}</section>`).join('')}${unknown?`<p class="notice">有回复未完整返回，可能已计费。请核对服务商记录；原请求不会重发。</p>${ended?`<button type="button" data-model-usage-review data-ai-action="review_model_calls" data-id="${esc(operation.id)}">保留记录，解除连接占用</button>`:'<p class="subtle">先核对原任务进度，结束后可解除连接占用。</p>'}`:''}</details>`;
}

export function bindModelUsageReview({app,request,refresh,render,notify}){
 app.addEventListener('click',event=>{
  const button=event.target.closest('[data-model-usage-review]');if(!button)return;
  event.preventDefault();event.stopImmediatePropagation();
  if(!window.confirm('请先核对服务商的原请求记录。确认保留未完整回复的记录并解除连接占用？费用仍待账单确认，原任务和原请求不会重发。'))return;
  button.disabled=true;
  request('ui_review_model_calls',{operationId:button.dataset.id,confirmed:true}).then(refresh).then(render).catch(notify).finally(()=>{button.disabled=false;});
 });
}
