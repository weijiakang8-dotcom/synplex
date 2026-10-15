// Existing business pages only. A page tab never creates a task or a module.
export const PAGE_NAMES={progress:'项目',task:'任务',materials:'资料',history:'记录',results:'成果',review:'待核对',connect:'扩展','new-project':'新建项目'};
export const PAGE_ACTIONS=['switch-page','close-page','pin-page','close-other-pages'];
const key=scope=>'synplex-pages:'+JSON.stringify(scope);
const read=(storage,k,fallback)=>{try{return JSON.parse(storage.getItem(k))??fallback;}catch{return fallback;}};
const write=(storage,k,value)=>{try{storage.setItem(k,JSON.stringify(value));}catch{/* A full session store must not prevent navigation. */}};
function clearStored(storage,prefix,known){
 const keys=new Set(known);
 try{for(let i=0;i<storage.length;i++){const k=storage.key(i);if(k?.startsWith(prefix))keys.add(k);}}catch{}
 for(const k of keys){try{storage.removeItem(k);}catch{}}
}
const initial=()=>({active:'progress',items:[{id:'progress',pinned:true}]});
function validated(value){
 if(!value||!Array.isArray(value.items))return initial();
 const seen=new Set(),items=[];
 for(const item of value.items){if(!item||!Object.hasOwn(PAGE_NAMES,item.id)||seen.has(item.id))continue;seen.add(item.id);items.push({id:item.id,pinned:item.pinned===true});}
 if(!items.length)return initial();
 return {items,active:seen.has(value.active)?value.active:items[0].id};
}
export function createWorkspacePages(storage){
 const scopes=new Map();
 function state(scope){const k=key(scope);if(!scopes.has(k))scopes.set(k,validated(read(storage,k,null)));return scopes.get(k);}
 function save(scope,value){scopes.set(key(scope),value);write(storage,key(scope),value);return value;}
 return {
  current:scope=>state(scope).active,
  open(scope,id){if(!Object.hasOwn(PAGE_NAMES,id))return state(scope).active;const value=state(scope);if(!value.items.some(t=>t.id===id))value.items.push({id,pinned:false});value.active=id;save(scope,value);return id;},
  act(scope,action,id){
   const value=state(scope),index=value.items.findIndex(t=>t.id===id),tab=value.items[index];
   if(!tab)return value.active;
   if(action==='switch-page')value.active=id;
   if(action==='pin-page')tab.pinned=!tab.pinned;
   if(action==='close-other-pages'){value.items=value.items.filter(t=>t.id===id||t.pinned);value.active=id;}
   if(action==='close-page'&&!tab.pinned){value.items.splice(index,1);if(value.active===id)value.active=value.items[Math.min(index,value.items.length-1)]?.id||'progress';}
   if(!value.items.length)value.items=[{id:'progress',pinned:true}];
   return save(scope,value).active;
  },
  markup(scope,esc){
   const value=state(scope),active=value.items.find(t=>t.id===value.active);
   return `<div class="page-tabs" data-ai-context="pages"><div class="page-tab-list" role="tablist" aria-label="已打开的页面">${value.items.map(t=>`<div class="page-tab"><button type="button" role="tab" id="page-tab-${t.id}" aria-controls="page-panel" aria-selected="${t.id===value.active}" tabindex="${t.id===value.active?'0':'-1'}" data-action="switch-page" data-id="${t.id}">${esc(PAGE_NAMES[t.id])}${t.pinned?'<span aria-label="已固定"> ·</span>':''}</button>${!t.pinned?`<button type="button" data-action="close-page" data-id="${t.id}" aria-label="关闭${esc(PAGE_NAMES[t.id])}页面" data-tip="关闭页面，保留草稿和已保存的工作">×</button>`:''}</div>`).join('')}</div><details class="page-menu"><summary aria-label="页面操作" data-ai-id="page-menu" data-ai-role="action" data-ai-action="open_page_menu">⋯</summary><div><button type="button" data-action="find-page" data-tip="输入页面名称即可打开，也可按 ⌘K 或 Ctrl+K">查找页面</button><button type="button" data-action="pin-page" data-id="${value.active}">${active.pinned?'取消固定':'固定页面'}</button><button type="button" data-action="close-other-pages" data-id="${value.active}" data-tip="保留当前页面和已固定的页面，草稿不会删除">关闭其他页面</button></div></details></div>`;
  },
  clear(){clearStored(storage,'synplex-pages:',scopes.keys());scopes.clear();},
 };
}

// Keep the original file input node during redraws: no byte copies, no file paths,
// no file upload or browser-specific FileList assignment is needed.
const draftForms={materials:'import-form','new-project':'project-form',history:'search-form'};
const draftKey=(scope,view)=>'synplex-page-draft:'+JSON.stringify(scope)+':'+view;
function missingNames(input){try{const value=JSON.parse(input.dataset.unselectedFiles||'[]');return Array.isArray(value)?value:[];}catch{return [];}}
function restoreFile(document,target,file,names){
 if(!target)return;
 if(file){target.replaceWith(file);target=file;}
 if(target.files.length||!Array.isArray(names)||!names.length)return;
 target.dataset.unselectedFiles=JSON.stringify(names);
 const note=document.createElement('p');note.className='notice';note.setAttribute('role','status');
 note.textContent='页面重新打开后，请重新选择文件：'+names.join('、')+'。文件尚未上传。';target.closest('label').append(note);
}
export function createPageDrafts(storage){
 const files=new Map(),positions=new Map(),drafts=new Map(),keys=new Set();
 return {
  capture(document,scope,view){
   if(!scope)return;
   const k=draftKey(scope,view),content=document.scrollingElement||document.querySelector('main .content');
   if(content)positions.set(k,{top:content.scrollTop,left:content.scrollLeft});
   const form=document.querySelector('#'+draftForms[view]);if(!form?.elements)return;
   const values={},names=[];
   for(const input of form.elements){
    if(!input.name)continue;
    if(input.type==='file'){files.set(k,input);names.push(...[...input.files].map(f=>f.name));if(!names.length)names.push(...missingNames(input));}
    else values[input.name]=input.value;
   }
   const saved={values,fileNames:names};drafts.set(k,saved);keys.add(k);write(storage,k,saved);
  },
  restore(document,scope,view){
   if(!scope)return;
   const k=draftKey(scope,view),position=positions.get(k),content=document.scrollingElement||document.querySelector('main .content');
   if(content){content.scrollTop=position?.top||0;content.scrollLeft=position?.left||0;}
   const form=document.querySelector('#'+draftForms[view]),saved=drafts.get(k)||read(storage,k,null);if(!form?.elements||!saved)return;
   keys.add(k);
   for(const input of form.elements)if(input.name&&input.type!=='file'&&Object.hasOwn(saved.values||{},input.name))input.value=saved.values[input.name];
   restoreFile(document,form.querySelector('input[type=file]'),files.get(k),saved.fileNames);
  },
  acknowledge(document,scope,view,submitted){
   const form=document.querySelector('#'+draftForms[view]);if(!form)return;
   for(const input of form.elements){
    if(!input.name)continue;
    if(input.type==='file'){
     if(input.files[0]!==submitted.get(input.name)&&input.files.length)continue;
     input.value='';input.removeAttribute('data-unselected-files');
    }else if(input.value===submitted.get(input.name))input.value='';
   }
   this.capture(document,scope,view);
  },
  clear(){files.clear();positions.clear();drafts.clear();clearStored(storage,'synplex-page-draft:',keys);keys.clear();},
 };
}
