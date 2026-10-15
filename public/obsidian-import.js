import {noteIdentity,noteTitle,OBSIDIAN_SOURCE} from './obsidian-notes.js';
import {errorText} from './user-copy.js';
const protocolVersion='synplex.workspace/1.0.0';
const hash=async bytes=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const obsidianImportButton=()=>'<button type="button" data-obsidian-open data-ai-id="import-obsidian" data-ai-action="import_notes" data-tip="从笔记库选择要加入本项目的文档，不修改原笔记和链接">导入笔记库</button>';
function content(esc){return `<div class="dialog-heading"><h2>导入笔记库</h2><button type="button" id="close-dialog" aria-label="关闭">×</button></div><p>选择 Obsidian 笔记库，再勾选文档。只上传你选中的笔记，原文件和链接保持不变。</p><label>笔记库名称<input id="vault-name" value="我的笔记" maxlength="120" placeholder="例如：我的项目笔记"></label><div class="button-row"><label>选择笔记库<input id="vault-folder" type="file" webkitdirectory multiple aria-label="选择笔记库"></label><label>或选择几篇笔记<input id="vault-files" type="file" accept=".md" multiple aria-label="选择几篇笔记"></label></div><p class="subtle">每份不超过2兆，每次最多300篇、合计32兆。隐藏文件和设置不会上传。只选几篇时，请保持原来的笔记库名称；子目录笔记请用“选择笔记库”。</p><div id="vault-plan"></div><p id="vault-status" role="status" aria-live="polite"></p><p id="vault-error" role="alert"></p><button type="button" id="vault-import" class="primary" disabled>导入所选</button>`;}
function chosenFiles(files,vault){
 const result=[],seen=new Set();let skipped=0;
 for(const file of files){
  const raw=file.webkitRelativePath||file.name,path=file.webkitRelativePath?raw.split('/').slice(1).join('/'):raw;
  try{noteIdentity(vault,path);if(!file.size||file.size>2*1024*1024||seen.has(path)){skipped++;continue;}}
  catch{skipped++;continue;}
  seen.add(path);result.push({file,path});if(result.length===300)break;
 }
 return {items:result,skipped:skipped+Math.max(0,files.length-seen.size-skipped)};
}
async function prepareSelected(items,vault,boxes){
 const selected=items.filter((_,i)=>boxes.has(String(i)));
 if(!selected.length)throw Error('请先勾选要导入的笔记。');
 if(selected.reduce((n,x)=>n+x.file.size,0)>32*1024*1024)throw Error('所选笔记合计超过32兆，请分几次导入。');
 const prepared=[];
 for(const item of selected){
  const identity=noteIdentity(vault,item.path),bytes=await item.file.arrayBuffer();
  let text;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw Error('这篇笔记无法读取：'+item.path+'。请先在笔记软件中另存为普通文字。');}
  prepared.push({...item,identity,bytes,title:noteTitle(item.path,text),sha256:await hash(bytes)});
 }
 return prepared;
}
function knownNoteState(prior,item,saved){
 if(saved)return null;
 if(prior?.sha256===item.sha256&&['succeeded','needs_input'].includes(prior.status))return 'unchanged';
 return prior?.locked?'locked':null;
}
async function importOne(c,item,scope,index,status){
 const prior=index.items.find(n=>n.vault===item.identity.vault&&n.path===item.path);
 const key='synplex-vault-pending:'+JSON.stringify(scope),saved=JSON.parse(c.storage.getItem(key)||'null');
 const requestId='obs:'+await hash(new TextEncoder().encode(JSON.stringify({...item.identity,sha256:item.sha256})));
 if(saved&&saved.metadata.requestId!==requestId)throw Error('上一份笔记的保存结果还需核对，请先重新选择：'+saved.path+'。其他笔记尚未上传。');
 const known=knownNoteState(prior,item,saved);if(known)return known;
 const current=await c.request('ui_history',{scope});
 const metadata=saved?.metadata||{protocolVersion,scope,requestId,expectedStateRevision:current.state.stateRevision,format:'text/markdown',sourceSystem:OBSIDIAN_SOURCE,formatVersion:'1',sessionId:JSON.stringify(item.identity),eventId:requestId,occurredAt:null,sourceName:item.file.name};
 let reply;
 if(saved?.operationId)reply=await c.request('get_import_result',{scope,operationId:saved.operationId});
 else{
  c.storage.setItem(key,JSON.stringify({metadata,path:item.path}));
  const form=new FormData();form.set('metadata',JSON.stringify(metadata));form.set('source',new File([item.bytes],item.file.name,{type:'text/markdown'}));
  const response=await fetch('/api/v1/import_source',{method:'POST',body:form});reply=await response.json();
  if(!response.ok){if(response.status<500)c.storage.removeItem(key);throw Error(errorText(reply));}
  c.storage.setItem(key,JSON.stringify({metadata,path:item.path,operationId:reply.operation.id}));
 }
 for(let i=0;i<60&&['queued','running'].includes(reply.operation.status);i++){
  status.textContent='正在整理：'+item.path;await new Promise(r=>setTimeout(r,500));reply=await c.request('get_import_result',{scope,operationId:reply.operation.id});
 }
 if(['queued','running','unknown'].includes(reply.operation.status))throw Error('这篇笔记已保存，处理结果还需核对：'+item.path+'。请稍后重新选择同一篇查看结果，不要另建导入。');
 c.storage.removeItem(key);
 if(reply.result?.outcome!=='complete')throw Error('原文件已保留，但这篇笔记还没完整读取：'+item.path+'。请到“资料”核对内容。');
 return 'imported';
}
export function bindObsidianImport(c){
 c.app.addEventListener('click',async event=>{
  if(!event.target.closest('[data-obsidian-open]'))return;
  const scope=structuredClone(c.getScope()),dialog=c.dialog;let items=[],running=false;
  dialog.innerHTML=content(c.esc);dialog.querySelector('#close-dialog').onclick=()=>dialog.close();dialog.showModal();
  const status=dialog.querySelector('#vault-status'),error=dialog.querySelector('#vault-error'),button=dialog.querySelector('#vault-import'),name=dialog.querySelector('#vault-name');
  function select(event){
   const files=[...event.target.files];if(event.target.id==='vault-folder'&&files[0])name.value=files[0].webkitRelativePath.split('/')[0];
   try{const plan=chosenFiles(files,name.value);items=plan.items;dialog.querySelector('#vault-plan').innerHTML=items.map((x,i)=>`<label class="check"><input type="checkbox" name="vault-note" value="${i}" data-ai-key="note:${c.esc(x.path)}">${c.esc(x.path)} <small>${(x.file.size/1024).toFixed(1)} 千字节</small></label>`).join('');status.textContent=`可选择 ${items.length} 篇${plan.skipped?'，另有 '+plan.skipped+' 份未列入（格式、大小或设置文件）':''}。`;button.disabled=!items.length;error.textContent='';}
   catch(e){error.textContent=errorText(e);}
  }
  dialog.querySelector('#vault-folder').onchange=select;dialog.querySelector('#vault-files').onchange=select;
  button.onclick=async()=>{
   if(running)return;running=true;button.disabled=true;error.textContent='';const controls=[...dialog.querySelectorAll('input')];controls.forEach(x=>x.disabled=true);
   try{
    if(!same(scope,c.getScope()))throw Error('项目已切换，请在当前项目重新打开导入。');
    const selected=await prepareSelected(items,name.value,new Set([...dialog.querySelectorAll('[name=vault-note]:checked')].map(x=>x.value))),index=await c.request('ui_obsidian_notes',{scope}),counts={imported:0,unchanged:0,locked:0};
    for(const item of selected){status.textContent='正在保存：'+item.path;counts[await importOne(c,item,scope,index,status)]++;}
    status.textContent=`已导入 ${counts.imported} 篇，未变化 ${counts.unchanged} 篇，已锁定 ${counts.locked} 篇。请到“待核对”确认整理出的记录。`;await c.onImported(scope);
   }catch(e){error.textContent=errorText(e);}
   finally{running=false;button.disabled=false;controls.forEach(x=>x.disabled=false);}
  };
 });
}
