const esc=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const effortNames={default:'默认',none:'不额外思考',minimal:'简短',low:'快速',medium:'适中',high:'深入',xhigh:'更深入',max:'充分',ultra:'最深入'};
export const effortLabel=value=>effortNames[value]||'所选程度';
export function effortOptions(efforts,value){
 const invalid=!!value&&!efforts.includes(value);
 return (invalid?'<option value="" disabled selected data-unavailable>原思考程度已不可用，请重新选择</option>':'')+efforts.map(e=>`<option value="${esc(e)}" ${e===value?'selected':''}>${esc(effortLabel(e))}</option>`).join('');
}
export function modelControls(executors,draft){
  const choices=executors.find(x=>x.owner===draft.executor)?.selectionChoices||[];
  if(!choices.length)return '';
  if(!draft.model)draft.model=choices[0].id;
  const selected=choices.find(c=>c.id===draft.model),efforts=selected?.efforts||[];
  if(!draft.effort&&efforts.length)draft.effort=efforts[0];
  return `<div class="form-columns"><label>型号<select name="model" required data-ai-action="select_model">${selected?'':'<option value="" disabled selected data-unavailable>原型号已不可用，请重新选择</option>'}${choices.map(c=>`<option value="${esc(c.id)}" ${c.id===draft.model?'selected':''}>${esc(c.label)}</option>`).join('')}</select></label>
    <label>思考<select name="effort" required data-ai-action="select_effort">${effortOptions(efforts,draft.effort)}</select></label></div>`;
}
