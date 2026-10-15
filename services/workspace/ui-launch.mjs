import {lstatSync,readFileSync,writeFileSync,renameSync,realpathSync,unlinkSync} from 'node:fs';
import {join,resolve,sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {validateWire} from '../../packages/contracts/validate.mjs';

function privateRead(file){
  const stat=lstatSync(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('连接资料必须是仅本人可读的普通文件。');
  return readFileSync(file,'utf8');
}
function endpointURL(endpoint){
  if(typeof endpoint!=='string'||!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}$/.test(endpoint))throw new Error('连接只允许固定的本机地址。');
  const url=new URL(endpoint);
  if(Number(url.port)<1024)throw new Error('工作台连接地址不正确。');
  return endpoint;
}
export function writeUiLauncher(dataDir,{nonce,endpoint}){
  endpointURL(endpoint);
  if(typeof nonce!=='string'||!/^[a-f0-9]{64}$/.test(nonce))throw new Error('工作台返回的连接信息不正确。');
  const file=join(dataDir,'打开Synplex.html'),temporary=file+'.'+randomUUID()+'.tmp';
  try{
    writeFileSync(temporary,`<!doctype html><meta charset="utf-8"><meta name="referrer" content="no-referrer"><title>打开Synplex</title><form method="post" action="${endpoint}/api/v1/ui_pair"><input type="hidden" name="pair" value="${nonce}"><button>打开Synplex</button></form><script>document.forms[0].submit()</script>`,{flag:'wx',mode:0o600});
    renameSync(temporary,file);
  }catch(error){try{unlinkSync(temporary);}catch{}throw error;}
  return file;
}
export async function refreshUiLauncher(dataDir){
  dataDir=resolve(dataDir);
  const connection=JSON.parse(privateRead(join(dataDir,'connection.json'))),endpoint=endpointURL(connection.endpoint);
  validateWire('Scope',connection.scope);
  const tokenFile=resolve(connection.uiTokenFile);
  // macOS /var and /private/var may describe the same directory. The actual
  // containment is authoritative; privateRead still rejects a symlink token.
  if(!realpathSync(tokenFile).startsWith(realpathSync(dataDir)+sep))throw new Error('连接文件必须保存在当前工作台的资料文件夹内。');
  const token=privateRead(tokenFile).trim();
  const response=await fetch(`${endpoint}/api/v1/ui_launch`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:connection.scope})});
  if(!response.ok)throw new Error('无法刷新入口，请确认工作台正在运行，且当前连接仍获准。');
  const pairing=await response.json();
  if(pairing.endpoint!==endpoint)throw new Error('工作台连接地址发生变化，未保存新入口。请由维护人员核对。');
  return writeUiLauncher(dataDir,pairing);
}
