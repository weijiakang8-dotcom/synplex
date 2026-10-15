// Reposition existing surfaces only. No task creation, requests or execution.
const STORAGE_KEY='synplex-layout';
const defaults=()=>({navigation:218,task:360,collapsed:false,taskOpen:true});
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));
export function layoutGeometry(width,value,hasTask){
 const desktop=width>=1180,navigation=width>900?(value.collapsed?64:clamp(value.navigation,180,320)):180;
 const taskMax=Math.min(520,Math.max(280,width-navigation-420-12));
 return {desktop,navigation,task:clamp(value.task,280,taskMax),taskMax,split:desktop&&hasTask&&value.taskOpen};
}
function readSettings(storage){
 try{
  const saved=JSON.parse(storage.getItem(STORAGE_KEY)),value=defaults();
  if(!saved||typeof saved!=='object')return value;
  for(const name of ['navigation','task'])if(Number.isFinite(saved[name]))value[name]=saved[name];
  for(const name of ['collapsed','taskOpen'])if(typeof saved[name]==='boolean')value[name]=saved[name];
  return value;
 }catch{return defaults();}
}
function control(document,name,label,content){
 const element=document.createElement('button');element.type='button';element.dataset.layoutAction=name;
 element.dataset.aiAction=name;element.setAttribute('aria-label',label);element.dataset.tip=label;element.textContent=content;
 return element;
}
function separator(document,name,label,controlled){
 const element=document.createElement('div');element.className='layout-divider';element.tabIndex=0;
 element.dataset.layoutResize=name;element.dataset.aiId='layout:'+name;element.dataset.aiAction='resize_'+name;
 element.dataset.aiRole='separator';element.setAttribute('role','separator');element.setAttribute('aria-label',label);
 element.setAttribute('aria-orientation','vertical');element.setAttribute('aria-controls',controlled);
 element.dataset.tip='拖动调整宽度；也可用左右方向键，回车恢复默认宽度';return element;
}
function range(element,min,max,value){
 element.setAttribute('aria-valuemin',String(min));element.setAttribute('aria-valuemax',String(max));
 element.setAttribute('aria-valuenow',String(value));
}
export function createWorkspaceLayout(storage,window){
 let value=readSettings(storage),current=null,drag=null;
 const positions=new Map();
 const save=()=>{try{storage.setItem(STORAGE_KEY,JSON.stringify(value));}catch{/* Navigation must work with full storage. */}};
 function capture(){if(current&&!current.side.hidden)positions.set(current.key,current.side.scrollTop);}
 function apply(){
  if(!current)return;
  const {shell,navigation,main,panel,slot,side,left,right,toggle,taskToggle}=current;
  const size=layoutGeometry(window.innerWidth,value,!!panel);
  if(panel?.parentElement===side&&!size.split)capture();
  shell.classList.toggle('layout-split',size.split);shell.classList.toggle('navigation-collapsed',value.collapsed);
  shell.style.setProperty('--navigation-width',size.navigation+'px');shell.style.setProperty('--task-width',size.task+'px');
  navigation.classList.add('workspace-navigation');main.classList.add('workspace-main');
  toggle.setAttribute('aria-expanded',String(!value.collapsed));toggle.textContent=value.collapsed?'›':'‹';
  const label=value.collapsed?'展开导航':'收起导航';toggle.setAttribute('aria-label',label);toggle.dataset.tip=label;
  taskToggle.hidden=!panel||!size.desktop;taskToggle.textContent=size.split?'收起进度':'展开进度';
  taskToggle.setAttribute('aria-expanded',String(size.split));side.hidden=!size.split;
  left.hidden=window.innerWidth<=900||value.collapsed;right.hidden=!size.split;
  range(left,180,320,size.navigation);range(right,280,size.taskMax,size.task);
  if(panel){const target=size.split?side:slot;if(panel.parentElement!==target){target.append(panel);if(size.split)side.scrollTop=positions.get(current.key)||0;}}
 }
 function finishDrag(){
  if(!drag)return;
  current?.shell.classList.remove('layout-dragging');drag=null;save();
 }
 function move(event){
  if(!drag||event.pointerId!==drag.id)return;
  const delta=(event.clientX-drag.x)*(drag.name==='task'?-1:1),size=layoutGeometry(window.innerWidth,value,!!current?.panel);
  value[drag.name]=clamp(drag.start+delta,drag.name==='task'?280:180,drag.name==='task'?size.taskMax:320);apply();
 }
 function beginDrag(event){
  const handle=event.target.closest('[data-layout-resize]');
  if(!current||!handle||event.button!==0)return;
  event.preventDefault();const name=handle.dataset.layoutResize;
  drag={name,id:event.pointerId,x:event.clientX,start:layoutGeometry(window.innerWidth,value,!!current.panel)[name]};
  handle.setPointerCapture(event.pointerId);current.shell.classList.add('layout-dragging');
 }
 function resizeKey(event){
  const handle=event.target.closest('[data-layout-resize]');
  if(!handle||event.isComposing||!['ArrowLeft','ArrowRight','Home','End','Enter'].includes(event.key))return;
  event.preventDefault();const name=handle.dataset.layoutResize,size=layoutGeometry(window.innerWidth,value,!!current?.panel);
  const min=name==='task'?280:180,max=name==='task'?size.taskMax:320;
  if(event.key==='Enter')value[name]=defaults()[name];
  else if(event.key==='Home')value[name]=min;
  else if(event.key==='End')value[name]=max;
  else value[name]=clamp(size[name]+(event.key==='ArrowRight'?20:-20)*(name==='task'?-1:1),min,max);
  apply();save();
 }
 function togglePane(event){
  const action=event.target.closest('[data-layout-action]')?.dataset.layoutAction;
  if(action==='toggle_navigation')value.collapsed=!value.collapsed;
  else if(action==='toggle_task_progress')value.taskOpen=!value.taskOpen;
  else return;
  apply();save();
 }
 const resize=()=>{finishDrag();apply();};
 window.addEventListener('resize',resize);window.addEventListener('pointermove',move);
 window.addEventListener('pointerup',finishDrag);window.addEventListener('pointercancel',finishDrag);window.addEventListener('blur',finishDrag);
 window.document.addEventListener('pointerdown',beginDrag);window.document.addEventListener('keydown',resizeKey);window.document.addEventListener('click',togglePane);
 return {
  capture,
  attach(root,key){
   finishDrag();current=null;
   const shell=root.querySelector('.shell');if(!shell)return;
   const document=root.ownerDocument,navigation=shell.querySelector('#workspace-navigation'),main=shell.querySelector('#workspace-main');
   const panel=main.querySelector('#execution-panel'),slot=document.createElement('div');slot.className='execution-slot';
   if(panel)panel.replaceWith(slot);
   const side=document.createElement('aside');side.id='task-progress';side.className='task-progress';side.setAttribute('aria-label','任务进度');
   const heading=document.createElement('h2');heading.textContent='任务进度';side.append(heading);
   const left=separator(document,'navigation','导航宽度','workspace-navigation'),right=separator(document,'task','任务进度宽度','task-progress');
   navigation.after(left);main.after(right,side);
   const toggle=control(document,'toggle_navigation','收起导航','‹');toggle.className='navigation-toggle';navigation.prepend(toggle);
   const taskToggle=control(document,'toggle_task_progress','展开或收起任务进度','收起进度');main.querySelector('header').append(taskToggle);
   current={key,shell,navigation,main,panel,slot,side,left,right,toggle,taskToggle};apply();
  },
  clear(){finishDrag();positions.clear();current=null;value=defaults();try{storage.removeItem(STORAGE_KEY);}catch{}},
 };
}
