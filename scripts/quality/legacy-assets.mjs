// Read-only, bounded verification: cloud placeholders must not hang the gate.
import {spawn} from 'node:child_process';
const reader="import{readFileSync}from'node:fs';import{createHash}from'node:crypto';process.stdout.write(createHash('sha256').update(readFileSync(process.argv[1])).digest('hex'));";
function fingerprint(path,timeoutMs){
 return new Promise(resolve=>{
  const child=spawn(process.execPath,['--input-type=module','-e',reader,path],{stdio:['ignore','pipe','ignore']});
  let value='',done=false;
  const finish=result=>{if(done)return;done=true;clearTimeout(timer);child.stdout.destroy();child.kill('SIGKILL');child.unref();resolve(result);};
  const timer=setTimeout(()=>finish({status:'unreadable',reason:'读取超时；请确认原文件已下载到本机'}),timeoutMs);
  child.stdout.on('data',bytes=>{value+=bytes;if(value.length>64)finish({status:'unreadable',reason:'指纹读取异常'});});
  child.on('error',()=>finish({status:'unreadable',reason:'无法启动只读核对'}));
  child.on('close',code=>finish(code===0&&/^[a-f0-9]{64}$/.test(value)?{status:'read',sha256:value}:{status:'unreadable',reason:'原文件不可读取'}));
 });
}
export async function auditLegacyAssets(files,{timeoutMs=4000,concurrency=4}={}){
 if(!Number.isSafeInteger(timeoutMs)||timeoutMs<1||!Number.isSafeInteger(concurrency)||concurrency<1||concurrency>8)throw Error('资产核对参数无效。');
 const results=new Array(files.length);let next=0;
 await Promise.all(Array.from({length:Math.min(concurrency,files.length)},async()=>{
  while(next<files.length){const index=next++,file=files[index],read=await fingerprint(file.path,timeoutMs);
   results[index]={path:file.path,...(read.status==='read'?{status:read.sha256===file.sha256?'unchanged':'changed',actualSha256:read.sha256}:read)};
  }
 }));
 return results;
}
