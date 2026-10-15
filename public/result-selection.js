const pendingKey='synplex-pending-result-selection';
export function selectedResultNeedsReview(resultId,plans){return plans.some(p=>p.nodes.some(n=>n.resultId===resultId&&n.resultSelection&&!n.review));}
export function resultSelectionNote(node,esc){return node.resultSelection?`<details><summary>选用原因${!node.review?' · 需要再次检查':''}</summary><p class="excerpt">${esc(node.resultSelection.note)}</p><p class="subtle">没有重新执行任务，其他版本和费用仍保留。</p></details>`:'';}
function pending(scope){
 try{const value=JSON.parse(sessionStorage.getItem(pendingKey)||'null');return value?.current&&JSON.stringify(value.current.scope)===JSON.stringify(scope)?value:null;}catch{return null;}
}
export function resultSelectionRecovery(scope,esc){
 const saved=pending(scope);return saved?`<p class="notice" role="status">上次选用成果还需要核对，不会重新执行任务。<button data-action="result-versions" data-id="${esc(saved.current.resultId)}">核对上次选择</button></p>`:'';
}
export function resultSelectionForm(version,plans,esc,note=''){
 const related=plans.flatMap(plan=>plan.nodes.filter(n=>n.history.some(h=>h.runId===version.runId)).map(node=>({plan,node})));
 const available=related.filter(({plan,node})=>node.resultId&&node.resultId!==version.id&&!['ready','prepared','needs_input','blocked_dependency','stale_input'].includes(node.status)&&!plan.nodes.some(n=>['queued','running','unknown'].includes(n.status)));
 if(!available.length)return '<p class="subtle">只有安排步骤中的其他已保存成果才能重新选用；执行未定或前置资料有变化时，先处理原任务。</p>';
 if(version.artifacts.some(a=>!a.saved))return '<p class="notice">先保存这版的所有原文件，再重新选用。</p>';
 const options=(available.length>1?'<option value="">选择步骤</option>':'')+available.map(({plan,node})=>`<option value="${esc(plan.id)}:${esc(node.id)}">${esc(plan.title)} · ${esc(node.title)}</option>`).join('');
 return `<form id="result-selection-form" data-result="${esc(version.id)}"><h3>重新选用</h3><p class="subtle">不重新生成文件，不替换其他版本或删除费用。选用后需要再次检查，相关后续步骤会核对输入是否过期。</p><label>用于哪个步骤<select name="step" required>${options}</select></label><label>选用原因<textarea name="note" required maxlength="4000" rows="2">${esc(note)}</textarea></label><button type="submit" data-ai-action="adopt_task_result">选用这版成果</button><p role="alert"></p></form>`;
}
export function bindResultSelection({dialog,detail,getPlans,getScope,enabled,savedMutation,notify,finish,isCurrent,esc}){
 if(!enabled)return ()=>{};
 const host=document.createElement('section');host.id='result-selection';dialog.append(host);let note='';
 const submit=async(body,form)=>{
  const button=form.querySelector('button');button.disabled=true;
  try{await savedMutation('ui_adopt_task_result',body,pendingKey);if(isCurrent()){dialog.close();finish();notify('已选用这版成果，请再次检查。其他版本与费用仍保留，尚未执行后续步骤。');}}
  catch(error){if(isCurrent()){notify(error);render();}}
  finally{button.disabled=false;}
 };
 const render=()=>{
  note=host.querySelector('[name=note]')?.value??note;
  const saved=pending(getScope());
  if(saved){
   host.innerHTML='<p class="notice">上次选择还需要核对，先查看它的结果，再作新的选择。</p><form id="result-selection-recovery"><button data-ai-action="reconcile_result_selection">核对上次选择</button></form>';
   host.querySelector('form').onsubmit=e=>{e.preventDefault();e.stopPropagation();const {scope,...body}=saved.current;submit(body,e.currentTarget);};return;
  }
  const version=detail.versions.find(v=>v.id===dialog.querySelector('#result-version-select').value);
  host.innerHTML=resultSelectionForm(version,getPlans(),esc,note);const form=host.querySelector('form');if(!form)return;
  form.onsubmit=e=>{
   e.preventDefault();e.stopPropagation();const data=new FormData(form),selected=String(data.get('step'));
   const match=getPlans().flatMap(plan=>plan.nodes.map(node=>({plan,node}))).find(({plan,node})=>`${plan.id}:${node.id}`===selected);if(!match)return;
   submit({planId:match.plan.id,nodeId:match.node.id,resultId:version.id,stepHash:match.node.executionHash,note:String(data.get('note'))},form);
  };
 };render();return render;
}
