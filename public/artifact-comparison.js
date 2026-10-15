import {fileLabel} from './user-copy.js';
import {textDifference} from './text-difference.js';
export function artifactComparisonForm(current,other,esc){
 const choices=version=>version.artifacts.filter(a=>a.saved),before=choices(other),after=choices(current);
 if(!before.length||!after.length)return '<p class="notice">两版原文件保存后，可以比较文字变化。</p>';
 const options=items=>'<option value="">选择文件</option>'+items.map(a=>`<option value="${esc(a.id)}" ${items.length===1?'selected':''}>${esc(fileLabel(a.name))}</option>`).join('');
 return `<form id="artifact-comparison-form" data-before="${esc(other.id)}" data-after="${esc(current.id)}"><h3>文件变化</h3><p class="subtle">从选中的版本，到当前查看的版本。多份文件请分别选择，不按文件名猜测。</p><div class="form-columns"><label>选中版本的文件<select name="beforeFile" required>${options(before)}</select></label><label>当前版本的文件<select name="afterFile" required>${options(after)}</select></label></div><button type="submit" data-ai-action="compare_artifact_text">比较文字</button><div id="artifact-comparison-output" role="status" aria-live="polite"></div></form>`;
}
export function comparisonContent(before,after,esc){
 if(before.sha256===after.sha256&&before.byteLength===after.byteLength)return '<p class="notice">两份文件内容完全相同。</p>';
 if([before,after].some(p=>!['complete','extracted'].includes(p.status)))return '<p class="notice">暂时无法完整比较这类文件，请下载两版后查看；没有将未读内容当作相同。</p>';
 const diff=textDifference(before.text,after.text),extracted=[before,after].some(p=>p.status==='extracted');
 const boundary=extracted?'只比较提取出的文字，图片、排版、批注和备注等未比较；文字相同不代表整个文件相同。':'按原文逐行比较；空行、行尾符号和末尾换行也计入变化。';
 if(diff.status!=='complete')return `<p class="notice">${esc(diff.notice)}</p>`;
 const summary=diff.sameText?'文字相同，但文件仍有变化。':`增加 ${diff.added} 行，删除 ${diff.removed} 行。`;
 const row=r=>`<p class="excerpt"><strong>${r.kind==='added'?'增加':r.kind==='removed'?'删除':'保留'} · ${r.kind==='removed'?'原':r.kind==='added'?'新':'原/新'}第${r.beforeLine??r.afterLine}${r.kind==='same'?' / '+r.afterLine:''}行</strong><br>${esc(r.text.replaceAll('\r','␍')||'（空行）')}</p>`;
 return `<p class="notice">${esc(boundary)}</p><p>${esc(summary)}</p>${diff.omittedUnchangedBefore?`<p class="subtle">前面 ${diff.omittedUnchangedBefore} 行未变，已折叠。</p>`:''}${diff.rows.map(row).join('')}${diff.omittedUnchangedAfter?`<p class="subtle">后面 ${diff.omittedUnchangedAfter} 行未变，已折叠。</p>`:''}`;
}
export function bindArtifactComparison({dialog,request,esc,isCurrent}){
 const form=dialog.querySelector('#artifact-comparison-form');if(!form)return;let generation=0;
 form.onchange=()=>{generation++;form.querySelector('#artifact-comparison-output').replaceChildren();};
 form.onsubmit=async event=>{
  event.preventDefault();event.stopPropagation();const data=new FormData(form),button=form.querySelector('button'),output=form.querySelector('#artifact-comparison-output'),mine=++generation;
  const current=()=>isCurrent()&&dialog.open&&dialog.querySelector('#artifact-comparison-form')===form&&mine===generation;
  button.disabled=true;output.textContent='正在比较文件…';
  try{
   const [before,after]=await Promise.all([request('ui_artifact_preview',{resultId:form.dataset.before,artifactId:String(data.get('beforeFile'))}),request('ui_artifact_preview',{resultId:form.dataset.after,artifactId:String(data.get('afterFile'))})]);
   if(current())output.innerHTML=comparisonContent(before,after,esc);
  }catch{if(current())output.textContent='暂时无法比较，请重新查看已有成果。原文件仍保留，不需要重新执行任务。';}
  finally{button.disabled=false;}
 };
}
