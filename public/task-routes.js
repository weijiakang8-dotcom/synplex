import {effortLabel,effortOptions} from './execution-selection.js';

export function routeDialog(quote,plan,esc){
 const selected=quote.routes.at(-1),choices=quote.choices;
 const names=a=>choices.find(c=>c.id===a.model)?.label||a.model;
 const reference=a=>a.price?`<p>输入 ${a.price.inputUsdPerMillion} · 已缓存输入 ${a.price.cachedInputUsdPerMillion} · 输出 ${a.price.outputUsdPerMillion}</p><p class="subtle">${esc(a.price.source)} · 自 ${esc(a.price.validFrom)}${a.price.validUntil?' 至 '+esc(a.price.validUntil):''}</p>`:`<p>${a.reason==='price_conflict'?'单价记录有冲突，请先核对':a.reason==='price_not_effective'?'目前没有适用的单价，旧记录不用于估算':'服务商单价待确认'}</p>`;
 return `<div class="dialog-heading"><h2>比较安排</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="subtle">只调整尚未准备的步骤。已准备、正在执行和已完成的步骤保留原设置，不重新执行。</p>
 <form id="task-route-form" data-plan="${esc(plan.id)}">${plan.nodes.map(n=>{
  const a=selected.assignments.find(a=>a.nodeId===n.id);
  if(n.generation)return `<fieldset><legend>${esc(n.title)}</legend><p>设置已固定 · ${esc(n.executionOptions?names(n.executionOptions)+' · '+effortLabel(n.executionOptions.effort):'沿用原工具设置')}</p></fieldset>`;
  const choice=choices.find(c=>c.id===a.model);
  return `<fieldset><legend>${esc(n.title)}</legend><label>型号<select name="model:${esc(n.id)}" required data-ai-action="choose_step_model">${choices.map(c=>`<option value="${esc(c.id)}" ${c.id===a.model?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label><label>思考<select name="effort:${esc(n.id)}" required data-ai-action="choose_step_effort">${effortOptions(choice.efforts,a.effort)}</select></label></fieldset>`;
 }).join('')}<button type="submit">更新比较</button><p role="alert"></p></form>
 ${quote.routes.map(r=>`<section data-ai-context="route:${esc(r.id)}"><h3>${esc(r.title)}</h3><table><thead><tr><th>步骤</th><th>型号</th><th>思考</th></tr></thead><tbody>${r.assignments.map(a=>`<tr><td>${esc(plan.nodes.find(n=>n.id===a.nodeId).title)}</td><td>${esc(names(a))}</td><td>${esc(effortLabel(a.effort))}</td></tr>`).join('')}</tbody></table><p>${r.estimate?`单轮参考：$${r.estimate.singleCallReferenceUsd.toFixed(4)} · 规划范围：$0～${r.estimate.planningEnvelopeUsd.toFixed(4)}`:'预计费用：待确认单价与用量'} · 完成时间：暂无实测依据</p>${r.estimate?`<details><summary>估算说明</summary><p>${esc(r.estimate.notice)}</p></details>`:''}<details><summary>单价与依据</summary><p class="subtle">单价单位：美元／百万计费单位。模型服务按文字片段计费，实际数量以账单为准。</p>${r.assignments.map(a=>`<h4>${esc(plan.nodes.find(n=>n.id===a.nodeId).title)}</h4>${reference(a)}`).join('')}</details><p class="notice">${esc(r.notice)}</p><button data-action="select-task-route" data-quote="${esc(quote.id)}" data-id="${esc(r.id)}" data-ai-action="select_task_route">采用这份安排</button></section>`).join('')}`;
}
