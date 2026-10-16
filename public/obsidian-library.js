// Weave's read-only vault rules, adapted to explicit browser directory grants.
// Only a handle is saved locally; unselected note contents never leave the device.
const DB='synplex-note-libraries',STORE='handles';
function database(){return new Promise((resolve,reject)=>{const request=indexedDB.open(DB,1);request.onupgradeneeded=()=>request.result.createObjectStore(STORE);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(Error('浏览器暂时不能记住笔记库。仍可选择文件导入。'));});}
async function stored(action,id,value){const db=await database();try{return await new Promise((resolve,reject)=>{const tx=db.transaction(STORE,action==='get'?'readonly':'readwrite'),store=tx.objectStore(STORE),request=action==='get'?store.get(id):action==='put'?store.put(value,id):store.delete(id);let result;request.onsuccess=()=>{result=request.result;};tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(Error('笔记库连接暂时无法保存，请重新选择。'));});}finally{db.close();}}
export async function connectNoteLibrary(storage){
 const handle=await window.showDirectoryPicker({mode:'read'}),id=crypto.randomUUID();
 await stored('put',id,handle);storage.setItem('synplex-note-library',JSON.stringify({id,name:handle.name}));return handle;
}
export function noteLibrary(storage){try{return JSON.parse(storage.getItem('synplex-note-library')||'null');}catch{return null;}}
export async function reopenNoteLibrary(storage){
 const value=noteLibrary(storage);if(!value)throw Error('请先连接一个 Obsidian 笔记库。');
 const handle=await stored('get',value.id);if(!handle)throw Error('浏览器没有保存这份连接，请重新选择笔记库。');
 if(await handle.queryPermission({mode:'read'})!=='granted'&&await handle.requestPermission({mode:'read'})!=='granted')throw Error('尚未允许读取笔记库，请重新连接并允许读取。');
 return handle;
}
export async function disconnectNoteLibrary(storage){const value=noteLibrary(storage);if(value)await stored('delete',value.id);storage.removeItem('synplex-note-library');}
export async function scanNoteLibrary(handle,{limit=10000}={}){
 const items=[];let skipped=0,partial=false,visited=0;
 async function walk(directory,prefix=''){
  if(prefix.split('/').length>40){skipped++;return;}
  for await(const [name,entry] of directory.entries()){
   if(++visited>50000||items.length>=limit){partial=true;return;}
   if(name.startsWith('.')||name==='node_modules'){skipped++;continue;}
   const path=prefix+name;
   if(entry.kind==='directory')await walk(entry,path+'/');
   else if(/\.md$/i.test(name)){
    try{const file=await entry.getFile();if(file.size>0&&file.size<=2*1024*1024)items.push({file,path});else skipped++;}catch{skipped++;}
   }
   if(partial)return;
  }
 }
 await walk(handle);items.sort((a,b)=>a.path.localeCompare(b.path,'zh-CN'));return {items,skipped,partial};
}
