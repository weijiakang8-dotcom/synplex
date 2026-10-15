import {PAGE_NAMES} from './workspace-pages.js';

// A deliberately limited local page lookup, never a task or model instruction.
export function findPages(text){
 const query=String(text).trim().replace(/[。！!？?]+$/u,'').replace(/\s+/gu,'')
  .replace(/^(?:请)?(?:帮我)?(?:打开|查看|切换到|进入)/u,'').replace(/页面$/u,'');
 const entries=Object.entries(PAGE_NAMES);
 const exact=entries.filter(([,name])=>name===query);
 return exact.length?exact:entries.filter(([,name])=>name.includes(query));
}

export function bindPageFinder({document,dialog,esc,getScope,canNavigate,navigate}){
 let select=()=>{};
 function open(){
  if(dialog.open||!getScope()||!canNavigate())return false;
  const scopeKey=JSON.stringify(getScope()),origin=document.activeElement;
  const current=()=>scopeKey===JSON.stringify(getScope())&&canNavigate();
  dialog.innerHTML=`<section data-ai-context="page-finder" aria-labelledby="page-finder-title"><div class="dialog-heading"><h2 id="page-finder-title">查找页面</h2><button type="button" id="close-dialog" aria-label="关闭">×</button></div><p class="subtle">只切换页面，当前内容会保留。</p><form id="page-finder-form"><label>页面名称<input name="page" autocomplete="off" maxlength="40" placeholder="例如：打开资料"></label><button type="submit">打开</button></form><p role="status" aria-live="polite"></p><div class="button-row" data-page-matches></div></section>`;
  const form=dialog.querySelector('form'),input=form.elements.page,status=dialog.querySelector('[role=status]'),list=dialog.querySelector('[data-page-matches]');
  function choose(id){
   if(!Object.hasOwn(PAGE_NAMES,id)||!current()){status.textContent='当前正在保存，请稍后再切换页面。';return;}
   dialog.close();navigate(id);
  }
  function update(){
   const matches=findPages(input.value);
   list.innerHTML=matches.map(([id,name])=>`<button type="button" data-action="open-found-page" data-id="${id}">${esc(name)}</button>`).join('');
   status.textContent=matches.length?'':'没有这个页面，请选择“项目”“任务”“资料”等已有页面。';
   return matches;
  }
  form.onsubmit=event=>{event.preventDefault();const matches=update();if(matches.length===1)choose(matches[0][0]);else if(matches.length)status.textContent='请选择要打开的页面。';};
  input.oninput=update;
  select=id=>{if(dialog.open&&dialog.querySelector('#page-finder-form'))choose(id);};
  dialog.querySelector('#close-dialog').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>{if(origin?.isConnected)origin.focus();},{once:true});
  update();dialog.showModal();input.focus();return true;
 }
 function shortcut(event){
  if(event.isComposing||event.keyCode===229||event.repeat||event.altKey)return;
  if((event.metaKey||event.ctrlKey)&&event.key.toLowerCase()==='k'&&open())event.preventDefault();
 }
 document.addEventListener('keydown',shortcut);
 return {open,select:id=>select(id)};
}
