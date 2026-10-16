// A cloud placeholder can stall a local file read. Bound it without cancelling
// any saved import or modifying the original; late bytes cannot be uploaded.
export function readNoteBytes(file,{timeoutMs=8000,reader=new FileReader()}={}){
 return new Promise((resolve,reject)=>{
  let settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);reader.onload=reader.onerror=reader.onabort=null;error?reject(error):resolve(value);};
  const failure=()=>Object.assign(Error('这篇笔记暂时读不到。请先在电脑上下载原文件，再重新选择导入。'),{code:'note_read_unavailable'});
  const timer=setTimeout(()=>{finish(failure());reader.abort();},timeoutMs);
  reader.onload=()=>finish(null,reader.result);reader.onerror=reader.onabort=()=>finish(failure());
  try{reader.readAsArrayBuffer(file);}catch{finish(failure());}
 });
}
