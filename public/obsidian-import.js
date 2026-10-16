import {connectNoteLibrary,reopenNoteLibrary,disconnectNoteLibrary,noteLibrary,scanNoteLibrary} from './obsidian-library.js';
import {noteIdentity,noteTitle,OBSIDIAN_SOURCE} from './obsidian-notes.js';
import {errorText} from './user-copy.js';
import {readNoteBytes} from './note-reader.js';
let activeUpload=false;
globalThis.window?.addEventListener('beforeunload',event=>{if(activeUpload){event.preventDefault();event.returnValue='';}});
const protocolVersion='synplex.workspace/1.0.0';
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const obsidianImportButton=()=>'<button type="button" data-obsidian-open data-ai-id="import-obsidian" data-ai-action="import_notes" data-tip="从笔记库选择要加入本项目的文档，不修改原笔记和链接">Obsidian 笔记库</button>';
function content(esc){return `<div class="dialog-heading"><h2>Obsidian 笔记库</h2><button type="button" id="close-dialog" aria-label="关闭">×</button></div><p>选择 Obsidian 笔记库，再勾选文档。只上传你选中的笔记，原文件和链接保持不变。上传完成后在后台整理，可以关闭窗口继续工作；全部上传完成前请勿关闭浏览器。</p><label>笔记库名称<input id="vault-name" value="我的笔记" maxlength="120" placeholder="例如：我的项目笔记"></label><div id="vault-connection"></div><div class="button-row"><button type="button" id="vault-connect">连接笔记库</button><button type="button" id="vault-reopen">读取已连接的笔记库</button><button type="button" id="vault-disconnect">断开连接</button></div><details><summary>其他导入方式</summary><div class="button-row"><label>选择笔记库<input id="vault-folder" type="file" webkitdirectory multiple aria-label="选择笔记库"></label><label>或选择几篇笔记<input id="vault-files" type="file" accept=".md" multiple aria-label="选择几篇笔记"></label></div><p class="subtle">每篇不超过2兆，一次可浏览一万篇。连接保存在当前浏览器，之后点击“读取已连接的笔记库”查看新增和修改。隐藏文件和设置不会上传。只选几篇时，请保持原来的笔记库名称；子目录笔记请用“选择笔记库”。</p></details><label>查找笔记<input id="vault-search" type="search" placeholder="输入标题或文件夹名称"></label><div class="button-row"><button type="button" id="vault-select-all">全选搜索结果</button><button type="button" id="vault-select-none">取消选择</button></div><p id="vault-count" role="status"></p><div id="vault-plan"></div><button type="button" id="vault-more" hidden>显示更多</button><p id="vault-status" role="status" aria-live="polite"></p><p id="vault-error" role="alert"></p><button type="button" id="vault-import" class="primary" disabled>导入所选</button>`;}
function chosenFiles(files,vault){
 const result=[],seen=new Set();let skipped=0;
 for(const file of files){
  const raw=file.webkitRelativePath||file.name,path=file.webkitRelativePath?raw.split('/').slice(1).join('/'):raw;
  try{noteIdentity(vault,path);if(!file.size||file.size>2*1024*1024||seen.has(path)){skipped++;continue;}}
  catch{skipped++;continue;}
  seen.add(path);result.push({file,path});
 }
 return {items:result,skipped:skipped+Math.max(0,files.length-seen.size-skipped)};
}
async function prepareSelected(items,vault,boxes){
 const selected=items.filter((_,i)=>boxes.has(String(i)));
 if(!selected.length)throw Error('请先勾选要导入的笔记。');
 const prepared=[];
 for(const item of selected){
  const identity=noteIdentity(vault,item.path),bytes=await readNoteBytes(item.file);
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('这篇笔记无法读取：'+item.path+'。请先在笔记软件中另存为普通文字。');}
  prepared.push({...item,identity,bytes,title:noteTitle(item.path,text),sha256:await hash(bytes)});
 }
 return prepared;
}
function knownNoteState(prior,item,saved){
 if(saved)return null;
 if(prior?.sha256===item.sha256&&prior.status==='succeeded')return 'unchanged';
 if(prior?.sha256===item.sha256&&prior.status==='needs_input')return 'needs_review';
 return prior?.locked?'locked':null;
}
export async function admitNote(c,item,scope,key,metadata){
 for(let attempt=0;attempt<3;attempt++){
  c.storage.setItem(key,JSON.stringify({metadata,path:item.path}));
  const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.set('source',new File([item.bytes],item.file.name,{type:'text/markdown'}));
  const response=await fetch('/api/v1/import_source',{method:'POST',body:form}),reply=await response.json();
  if(response.ok)return reply;
  if(response.status<500)c.storage.removeItem(key);
  if(response.status===409&&reply.code==='stale_context'&&attempt<2){metadata.expectedStateRevision=(await c.request('ui_project_revision',{scope})).stateRevision;continue;}
  throw Error(errorText(reply));
 }
}
async function importOne(c,item,scope,index,status){
 const prior=index.items.find(n=>n.vault===item.identity.vault&&n.path===item.path);
 const key='synplex-vault-pending:'+JSON.stringify(scope),saved=JSON.parse(c.storage.getItem(key)||'null');
 const requestId='obs:'+await hash(new TextEncoder().encode(JSON.stringify({...item.identity,sha256:item.sha256})));
 if(saved&&saved.metadata.requestId!==requestId)throw Error('上一份笔记的保存结果还需核对，请先重新选择：'+saved.path+'。其他笔记尚未上传。');
 const known=knownNoteState(prior,item,saved);if(known)return known;
 if(!saved&&prior?.sha256===item.sha256&&['queued','running'].includes(prior.status))return 'queued';
 const current=await c.request('ui_project_revision',{scope});
 const metadata=saved?.metadata||{protocolVersion,scope,requestId,expectedStateRevision:current.stateRevision,format:'text/markdown',sourceSystem:OBSIDIAN_SOURCE,formatVersion:'1',sessionId:JSON.stringify(item.identity),eventId:requestId,occurredAt:null,sourceName:item.file.name};
 let reply;
 if(saved?.operationId)reply=await c.request('get_import_result',{scope,operationId:saved.operationId});
 else{
  reply=await admitNote(c,item,scope,key,metadata);
  c.storage.setItem(key,JSON.stringify({metadata,path:item.path,operationId:reply.operation.id}));
 }
 if(['queued','running'].includes(reply.operation.status)){c.storage.removeItem(key);return 'queued';}
 if(reply.operation.status==='unknown')throw Error('这篇笔记的保存结果还需核对：'+item.path+'。已保存的其他笔记会继续整理，请到资料页查看进度。');
 c.storage.removeItem(key);
 if(reply.result?.outcome!=='complete')return 'needs_review';
 return 'imported';
}
export function bindObsidianImport(c){
 c.app.addEventListener('click',async event=>{
  if(!event.target.closest('[data-obsidian-open]'))return;
  if(activeUpload){c.dialog.innerHTML='<h2>资料正在上传</h2><p>已上传的资料会在后台整理，可以继续其他工作。全部上传完成前请保持浏览器打开。</p><button type="button" id="upload-close">继续工作</button>';c.dialog.querySelector('#upload-close').onclick=()=>c.dialog.close();c.dialog.showModal();return;}
  const scope=structuredClone(c.getScope()),dialog=c.dialog;let items=[],running=false,selected=new Set(),visible=100;
  dialog.innerHTML='<section>'+content(c.esc)+'</section>';const root=dialog.firstElementChild;root.querySelector('#close-dialog').onclick=()=>dialog.close();dialog.showModal();
  const status=root.querySelector('#vault-status'),error=root.querySelector('#vault-error'),button=root.querySelector('#vault-import'),name=root.querySelector('#vault-name');
  const connection=()=>{const saved=noteLibrary(c.storage);root.querySelector('#vault-connection').textContent=saved?'已连接：'+saved.name:'尚未连接笔记库';root.querySelector('#vault-reopen').disabled=!saved;root.querySelector('#vault-disconnect').disabled=!saved;root.querySelector('#vault-connect').hidden=!window.showDirectoryPicker;};
  connection();
  const filtered=()=>items.map((item,i)=>({...item,i})).filter(x=>x.path.toLowerCase().includes(root.querySelector('#vault-search').value.toLowerCase()));
  function draw(){const found=filtered();root.querySelector('#vault-plan').innerHTML=found.slice(0,visible).map(x=>`<label class="check"><input type="checkbox" name="vault-note" value="${x.i}" data-ai-key="note:${c.esc(x.path)}" ${selected.has(String(x.i))?'checked':''}>${c.esc(x.path)} <small>${(x.file.size/1024).toFixed(1)} 千字节</small></label>`).join('');root.querySelector('#vault-count').textContent=`共 ${items.length} 篇，找到 ${found.length} 篇，已选 ${selected.size} 篇`;root.querySelector('#vault-more').hidden=found.length<=visible;button.disabled=running||!selected.size;}
  function display(plan){items=plan.items;selected.clear();visible=100;status.textContent=`可选择 ${items.length} 篇${plan.skipped?'，另有 '+plan.skipped+' 份未列入（格式、大小或设置文件）':''}。${plan.partial?'笔记库较大，已列出前一万篇；可选择子文件夹分批连接。':''}`;error.textContent='';draw();}
  function select(event){const files=[...event.target.files];if(event.target.id==='vault-folder'&&files[0])name.value=files[0].webkitRelativePath.split('/')[0];try{display(chosenFiles(files,name.value));}catch(e){error.textContent=errorText(e);}}
  root.querySelector('#vault-plan').onchange=e=>{if(e.target.name!=='vault-note')return;e.target.checked?selected.add(e.target.value):selected.delete(e.target.value);draw();};
  root.querySelector('#vault-search').oninput=()=>{visible=100;draw();};
  root.querySelector('#vault-more').onclick=()=>{visible+=100;draw();};
  root.querySelector('#vault-select-all').onclick=()=>{filtered().forEach(x=>selected.add(String(x.i)));draw();};
  root.querySelector('#vault-select-none').onclick=()=>{selected.clear();draw();};
  async function readLibrary(create){if(running)return;running=true;try{const handle=await(create?connectNoteLibrary(c.storage):reopenNoteLibrary(c.storage));name.value=handle.name;status.textContent='正在读取笔记目录…';display(await scanNoteLibrary(handle));connection();}catch(e){if(e.name!=='AbortError')error.textContent=errorText(e);}finally{running=false;draw();}}
  root.querySelector('#vault-connect').onclick=()=>readLibrary(true);
  root.querySelector('#vault-reopen').onclick=()=>readLibrary(false);
  root.querySelector('#vault-disconnect').onclick=async()=>{await disconnectNoteLibrary(c.storage);items=[];selected.clear();connection();draw();};
  root.querySelector('#vault-folder').onchange=select;root.querySelector('#vault-files').onchange=select;
  button.onclick=async()=>{
   if(running)return;running=true;activeUpload=true;button.disabled=true;error.textContent='';const controls=[...root.querySelectorAll('input,button:not(#vault-import):not(#close-dialog)')];controls.forEach(x=>x.disabled=true);
   try{
    if(!same(scope,c.getScope()))throw Error('项目已切换，请在当前项目重新打开导入。');
    if(!selected.size)throw Error('请先勾选要导入的笔记。');
    const index=await c.request('ui_obsidian_notes',{scope}),counts={imported:0,queued:0,unchanged:0,locked:0,needs_review:0,unreadable:0},unread=[];let processed=0;
    const summary=()=>`已处理 ${processed}/${selected.size} 篇：整理完成 ${counts.imported}，后台整理 ${counts.queued}，未变化 ${counts.unchanged}，已锁定 ${counts.locked}，需核对 ${counts.needs_review}，暂时读不到 ${counts.unreadable}。`;
    for(const [i,raw] of items.entries()){
     if(!selected.has(String(i)))continue;status.textContent=summary()+'正在读取：'+raw.path;
     let item;
     try{[item]=await prepareSelected([raw],name.value,new Set(['0']));}
     catch(e){if(e.code!=='note_read_unavailable')throw e;counts.unreadable++;processed++;unread.push(raw.path);error.textContent='以下笔记暂时读不到，已继续处理其他笔记：'+unread.join('、')+'。请先在电脑上下载原文件，再重新选择导入；已保存内容不会重复新增。';continue;}
     status.textContent=summary()+'正在保存：'+item.path;counts[await importOne(c,item,scope,index,status)]++;processed++;status.textContent=summary();if(processed%10===0)await c.onImported(scope);
    }
    status.textContent=`已保存 ${counts.imported+counts.queued} 篇，后台继续整理 ${counts.queued} 篇，未变化 ${counts.unchanged} 篇，已锁定 ${counts.locked} 篇，需核对 ${counts.needs_review} 篇，暂时读不到 ${counts.unreadable} 篇。可以关闭本窗口继续工作，处理进度在“资料”查看。整理出的记录仍需你核对。`;await c.onImported(scope);
   }catch(e){error.textContent=errorText(e);}
   finally{activeUpload=false;await c.onImported(scope);running=false;controls.forEach(x=>x.disabled=false);connection();draw();}
  };
 });
}
