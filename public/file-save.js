// The browser owns destination selection and any overwrite confirmation.
// No host filesystem path or model-provided URI reaches the server.
export async function saveVerifiedFile(name,load,{picker=globalThis.showSaveFilePicker?.bind(globalThis),download,crypto=globalThis.crypto}={}){
 name=Array.from(String(name).replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g,'-').replace(/^\.+/,'').trim()).slice(0,120).join('')||'项目文件';
 let handle;
 try{
  // Obtain the picker during the click gesture, before awaiting a request.
  if(picker)handle=await picker({suggestedName:name});
 }catch(error){if(error.name==='AbortError')return {status:'cancelled'};throw new Error('无法选择保存位置，尚未保存文件。');}
 const {bytes,sha256}=await load();
 const digest=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
 if(!sha256||digest!==sha256)throw new Error('文件内容未通过核对，尚未保存。请重新预览。');
 if(!handle){if(!download)throw new Error('浏览器无法保存，请使用下载入口。');download(name,new Blob([bytes]));return {status:'downloaded'};}
 let writer;
 try{writer=await handle.createWritable();await writer.write(bytes);await writer.close();return {status:'saved'};}
 catch{try{await writer?.abort();}catch{}throw new Error('文件保存未完成，请检查所选位置。项目里的原件仍保留。');}
}

export function notePreviewDialog(note,esc){
 return `<div class="dialog-heading"><h2>保存记录</h2><button id="close-dialog" aria-label="关闭">×</button></div><p class="notice">${esc(note.notice)}</p><p>文件名：${esc(note.name)}</p><details><summary>将要保存的完整内容</summary><pre class="excerpt">${esc(note.text)}</pre></details><button data-action="save-note-file" data-id="${esc(note.claimId)}" data-ai-action="save_note_file">保存到电脑</button><p class="subtle">浏览器支持时可选择位置；否则保存到下载文件夹。覆盖已有文件前，请核对文件名。文件离开工作台后，后续修订不会自动同步。</p>`;
}
