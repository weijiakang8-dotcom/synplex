const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const money=x=>x===null||x===undefined?'未知':`$${Number(x).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6})}`;
export function budgetCard(budget){
 if(!budget)return '';
 return `<details class="panel"><summary>费用额度</summary><p>本日已用及预留：${money(budget.dailyCommittedUsd)} / ${money(budget.dailyLimitUsd)}</p>
  <p>全部已用及预留：${money(budget.totalCommittedUsd)} / ${money(budget.totalLimitUsd)}</p>
  <p>每次先预留：${money(budget.reservationUsd)}</p>${budget.unknownCharges?`<p>还有 ${budget.unknownCharges} 次费用待核对。</p>`:''}
  <p class="subtle">这里只约束工作台的新任务，不代表共享账号余额。预留是计划额度；账单核对后按实际金额记录，已经发送的请求可能超过预留。</p></details>`;
}
export function usageCard(ledger,runId){
  const rows=ledger?.rows.filter(r=>r.runId===runId)||[];
  if(!rows.length)return '';
  return `<details class="usage-details"><summary>费用与用量</summary>${rows.map(r=>`<section>
    <p>账单金额：${money(r.paidUsd)}${r.paidSource==='user_invoice'?'（你已核对）':r.paidSource==='reported_invoice'?'（工具提交的账单）':''}</p>
    <p>按用量推算：${money(r.calculatedUsd)}${r.calculatedUsd!==null?'（不是实付）':''}</p>
    ${r.estimatedUsd!==null?`<p>先前预计：${money(r.estimatedUsd)}（不是实付）</p>`:''}
    <p class="subtle">读取文字：${r.usage.inputTokens??'未知'} · 生成文字：${r.usage.outputTokens??'未知'} · 重用文字：${r.usage.cachedInputTokens??'未知'}<span data-tip="这里按模型的计费单位记录，中文不一定等于字数。"> ⓘ</span></p>
    ${r.observations.length>1?`<p class="subtle">这次执行有 ${r.observations.length} 份回执，未重复累加。</p>`:''}
    <details><summary>${r.invoiceId?'更正账单金额':'核对账单金额'}</summary>
      <p class="subtle">只填写这次执行对应的金额；整月账单不能直接算作一次任务的费用。</p>
      <form class="usage-form" data-attempt="${esc(r.attemptId)}" data-invoice="${esc(r.invoiceId||'')}">
        <label>金额（美元）<input name="costUsd" type="number" min="0" max="1000000" step="any" required value="${r.invoiceId?esc(r.paidUsd):''}"></label>
        <label>账单出处<input name="receiptReference" required maxlength="512" value="${esc(r.receiptReference||'')}" placeholder="账单号和对应行号；不填写密钥"></label>
        <button>保存核对结果</button>
      </form>
    </details>
  </section>`).join('')}</details>`;
}
