const escape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const actions={keep_existing:'沿用原资料',keep_separate:'分别保留',correct:'更正结论',merge:'合并结论'};
export const conflictTitle=action=>actions[action]||'已核对';
export function readConflictChoice(form){
  const data=new FormData(form),action=String(data.get('action')),note=String(data.get('note'));
  return {action,note,...(['correct','merge'].includes(action)?{replacement:{
    type:String(data.get('type')),title:String(data.get('title')),body:String(data.get('body')),
    condition:String(data.get('condition')||'').trim()||null,supersedes:data.getAll('supersedes').map(String),
  }}:{})};
}
export function conflictCard(q,value={}){
  const e=escape,r=value.replacement||{},correcting=['correct','merge'].includes(value.action);
  return `<article class="record conflict-card" data-ai-id="conflict:${e(q.id)}" data-ai-role="conflict" data-ai-state="needs_review">
    <div class="record-top"><h3>两份资料内容不同</h3><span class="tag">待处理</span></div>
    <div class="form-columns"><div><h4>原资料</h4><blockquote>${e(q.existingText||'请下载原文件查看。')}</blockquote><button data-action="download" data-id="${e(q.existing.sourceId)}">下载原资料</button></div>
    <div><h4>新资料</h4><blockquote>${e(q.incomingText||'请下载原文件查看。')}</blockquote><button data-action="download" data-id="${e(q.incoming.sourceId)}">下载新资料</button></div></div>
    <form class="conflict-form" data-id="${e(q.id)}"><label>处理方式<select name="action">${Object.entries(actions).map(([key,title])=>`<option value="${key}" ${value.action===key?'selected':''}>${title}</option>`).join('')}</select></label>
    <fieldset data-correction ${correcting?'':'hidden disabled'}><legend>确认新的结论</legend>
      <label>标题<input name="title" required maxlength="160" value="${e(r.title)}"></label>
      <label>类型<select name="type">${Object.entries({fact:'事实',decision:'决定',failure:'遇到的问题',lesson:'经验',unknown:'待确认的信息'}).map(([key,title])=>`<option value="${key}" ${r.type===key?'selected':''}>${title}</option>`).join('')}</select></label>
      <label>内容<textarea name="body" required maxlength="16000" rows="4">${e(r.body)}</textarea></label>
      <label>适用条件<input name="condition" maxlength="4000" value="${e(r.condition)}" placeholder="经验适用于什么情况"></label>
      ${(q.relatedClaims||[]).length?`<p>哪些旧记录由新结论替代？未勾选的仍会保留。</p>${q.relatedClaims.map(c=>`<label><input type="checkbox" name="supersedes" value="${e(c.id)}" ${r.supersedes?.includes(c.id)?'checked':''}>${e(c.title)}：${e(c.body.slice(0,180))}</label>`).join('')}`:''}
    </fieldset><label>原因<textarea name="note" required rows="2" maxlength="8000">${e(value.note)}</textarea></label>
    <p class="subtle">原资料和旧结论都会保留。更正或合并后，新的结论按你的确认采用。</p>
    <button class="primary" data-ai-action="resolve_conflict">保存选择</button></form></article>`;
}
