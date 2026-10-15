// Introspection only: DOM availability never grants server or tool permissions.
const controls='button,input:not([type=hidden]),textarea,select,a[data-ai-action],summary[data-ai-action],[role=separator][data-ai-action]';
const set=(element,key,value)=>{if(element.dataset[key]!==value)element.dataset[key]=value;};
const entityOf=e=>[e.dataset.id,e.dataset.result,e.dataset.version,e.form?.dataset.id,e.form?.dataset.result,e.form?.dataset.run,e.form?.dataset.attempt].find(Boolean)||'';
function actionOf(element){
 if(element.dataset.aiAction)return element.dataset.aiAction;
 if(element.id==='close-dialog')return 'close_dialog';
 if(element.dataset.action)return element.dataset.action;
 if(element.dataset.nav)return 'open_'+element.dataset.nav;
 if(element.matches('input,textarea,select'))return 'set_field';
 if(element.dataset.tip)return 'view_help';
 return element.form&&element.type==='submit'?'submit':'activate';
}
function identity(element,action){
 const form=element.form,ancestors=[];
 for(let parent=element.parentElement;parent;parent=parent.parentElement){
  if(parent.dataset.aiContext)ancestors.unshift(parent.dataset.aiContext);
  else if(parent.dataset.aiId)ancestors.unshift(parent.dataset.aiId);
  else if(parent.id)ancestors.unshift(parent.id);
 }
 const labelField=element.closest('label')?.querySelector('input,textarea,select');
 const entity=entityOf(element);
 const key=element.dataset.aiKey||element.id||element.name||(action==='view_help'?(labelField?.name||'page_help'):'');
 const option=element.matches('input[type=radio],input[type=checkbox]')?element.value:'';
 return [...ancestors,action,entity,key,element.dataset.status||'',option].map(encodeURIComponent).join(':');
}
function stateOf(element,modal,busy){
 if(element.matches(':disabled'))return 'disabled';
 if(element.closest('[hidden],[aria-hidden=true],[inert]')||!element.getClientRects().length)return 'hidden';
 if(modal&&!modal.contains(element))return 'unavailable';
 // Match the existing UI guard. Inputs remain editable while a save is pending.
 const busyRegion=element.closest('[aria-busy=true]');
 if(busyRegion&&busyRegion.id!=='app'||busy&&(element.dataset.nav||element.dataset.action||element.id==='project-select'||element.form&&element.type==='submit'))return 'busy';
 return 'available';
}
export function annotateActions(root=document){
 const modal=root.querySelector('dialog:modal'),busy=root.querySelector('#app')?.getAttribute('aria-busy')==='true';
 const elements=[...root.querySelectorAll(controls)],ids=new Map();
 for(const element of elements){
  const action=actionOf(element);
  if(!element.dataset.aiId||element.dataset.aiGenerated==='true'){
   set(element,'aiId',identity(element,action));set(element,'aiGenerated','true');
  }
  set(element,'aiRole',element.matches('[role=separator]')?'separator':element.matches('input,textarea,select')?'field':element.dataset.nav?'navigation':'action');
  set(element,'aiAction',action);set(element,'aiState',stateOf(element,modal,busy));
  const matches=ids.get(element.dataset.aiId)||[];matches.push(element);ids.set(element.dataset.aiId,matches);
 }
 // Fail closed if a future template forgets an entity/surface key. Never hand
 // an agent an ambiguous selector or fabricate stability with a list index.
 for(const matches of ids.values())if(matches.length>1)for(const element of matches)set(element,'aiState','ambiguous');
}
export function availableOperations(root=document){
 annotateActions(root);
 return [...root.querySelectorAll(controls)].filter(e=>e.dataset.aiState==='available').map(e=>({
  id:e.dataset.aiId,role:e.dataset.aiRole,action:e.dataset.aiAction,
  entityId:entityOf(e)||null,
  form:e.form?.id||null,name:e.name||null,state:e.dataset.aiState,
 }));
}
export function observeActions(root=document){
 annotateActions(root);
 const observer=new MutationObserver(()=>annotateActions(root));
 observer.observe(root,{childList:true,subtree:true,attributes:true,attributeFilter:['disabled','hidden','aria-hidden','aria-busy','inert','open','class']});
 return ()=>observer.disconnect();
}
