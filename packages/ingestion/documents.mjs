import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {existsSync,realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {documentExtension} from '../../public/document-formats.js';
import {payloadHash} from '../contracts/validate.mjs';

export const DOCUMENT_PARSER_VERSION='synplex.weave-document-projection/1';
const MAX_BYTES=20*1024*1024, MAX_OUTPUT=8*1024*1024;
const directory=fileURLToPath(new URL('.',import.meta.url));
const worker=fileURLToPath(new URL('./document-worker.mjs',import.meta.url));
const modules=resolve(directory,'../../node_modules');

export function documentSandboxProfile() {
 const roots=[directory,modules,dirname(realpathSync(process.execPath)),'/System','/usr','/opt/homebrew','/Library/Fonts'];
 const reads=roots.map(path=>`(subpath ${JSON.stringify(path)})`).join(' ');
 // Node resolves package manifests up the ancestor chain, including absent
 // package.json paths. Permit those exact manifests, not whole parent folders.
 const manifests=[];for(let parent=resolve(directory);;parent=dirname(parent)){manifests.push(`(literal ${JSON.stringify(resolve(parent,'package.json'))})`);if(dirname(parent)===parent)break;}
 return `(version 1) (allow default) (deny network*) (deny file-write*) (deny file-read*) (allow file-read-metadata) (allow file-read* ${reads} ${manifests.join(' ')} (literal "/") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`;
}

function extract(bytes,extension,{timeoutMs=30000,table=null}={}) {
 return new Promise((resolveResult,reject)=>{
  // Node permissions limit filesystem access. On Mac the OS also denies network
  // and writes, including the textutil subprocess. Credentials are not inherited.
  const argv=['--max-old-space-size=192','--permission',`--allow-fs-read=${directory}`,`--allow-fs-read=${modules}`,'--allow-worker','--allow-addons'];
  if(process.platform==='darwin')argv.push('--allow-child-process');
  argv.push(worker);
  let command=process.execPath, args=argv;
  if(process.platform==='darwin'){
   if(!existsSync('/usr/bin/sandbox-exec'))return reject(new Error('这台电脑暂时无法安全读取此类文件，请先转换为文字文件。'));
   command='/usr/bin/sandbox-exec';args=['-p',documentSandboxProfile(),process.execPath,...argv];
  }else if(Number(process.versions.node.split('.')[0])<25){
   return reject(new Error('安全文档读取需要更新本工作台的运行环境，原文件仍会保存。'));
  }
  const child=spawn(command,args,{cwd:directory,env:{PATH:'/usr/bin:/bin',LANG:'en_US.UTF-8'},stdio:['pipe','pipe','pipe']});
  let output=[],size=0,settled=false;
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.kill('SIGKILL');error?reject(error):resolveResult(value);};
  const timer=setTimeout(()=>finish(new Error('文件读取超时，请拆分文件或转换为文字后再导入。')),timeoutMs);
  child.on('error',()=>finish(new Error('文件读取程序未能启动，原文件仍会保存。')));
  child.stdin.on('error',()=>{});
  child.stdout.on('data',chunk=>{size+=chunk.length;if(size>MAX_OUTPUT)finish(new Error('提取的文字过多，请拆分文件后再导入。'));else output.push(chunk);});
  // Do not pass dependency stack traces or paths to users.
  child.stderr.resume();
  child.on('close',code=>{
   if(settled)return;
   if(code!==0)return finish(new Error('文件暂时无法读取，请检查文件或转换为文字后再导入。'));
   try{
    const result=JSON.parse(Buffer.concat(output).toString('utf8'));
    if(result.ok!==true)finish(new Error(result.message||'没有提取到文字。'));
    else if(table){
     const t=result.table;
     if(!t||!Array.isArray(t.header)||!t.header.length||t.header.length>50||!Array.isArray(t.rows)||t.rows.length>10000||
        ![t.header,...t.rows].every(row=>Array.isArray(row)&&row.length===t.header.length&&row.every(x=>typeof x==='string'&&x.length<=10000))||
        typeof t.sheetName!=='string'||typeof t.range!=='string'||!Number.isInteger(t.headerRow)||t.headerRow<1||t.parserVersion!=='synplex.literal-spreadsheet/1'||typeof t.notice!=='string')finish(new Error('表格读取结果不完整，原件仍保留。'));
     else finish(null,t);
    }else if(typeof result.text!=='string'||result.text.length>1_000_000||!result.text.trim())finish(new Error('没有提取到可用文字，请检查文件。'));
    else finish(null,result.text);
   }catch{finish(new Error('文件读取结果不完整，原文件仍会保存。'));}
  });
  child.stdin.end(JSON.stringify({extension,base64:bytes.toString('base64'),...(table?{table}:{})}));
 });
}

export async function extractSpreadsheetTable(bytes,format,sheetName='',options={}){
 const extension=documentExtension(format);
 if(!['xlsx','xls','xlsm'].includes(extension)||!bytes.length||bytes.length>MAX_BYTES||typeof sheetName!=='string'||sheetName.length>200)throw new Error('请选择普通Excel文件和要计算的工作表。');
 return extract(Buffer.from(bytes),extension,{...options,table:{sheetName}});
}

export async function parseDocument(bytes,format,formatVersion,sourceHash,sourceSystem,options) {
 const extension=documentExtension(format);
 if(!extension)return null;
 let text=null,reason;
 if(formatVersion!=='1'||!['user-document','isolated-test','weave-explicit-export'].includes(sourceSystem))reason='来源或文件版本暂不支持读取。';
 else if(!bytes.length||bytes.length>MAX_BYTES)reason='原文件已保存；文档读取上限为20兆，请拆分后再导入。';
 else try{text=await extract(Buffer.from(bytes),extension,options);}catch(error){reason=error.message;}
 const blocks=text?[{id:`block:${payloadHash({sourceHash,parser:DOCUMENT_PARSER_VERSION,format,text})}`,text,rawStartByte:0,rawEndByte:bytes.length}]:[];
 // Binary documents only provide whole-file provenance, never exact compressed
 // byte offsets or completeness claims. Retain a full-file semantic coverage gap.
 const notice=text?'已提取文字；图片、排版、批注和备注可能未读取，请结合原文件核对。':/ZIP|CRC|Office/.test(reason)?'文件损坏、已加密或采用暂不支持的压缩方式，请另存为普通文档后重试。':reason;
 return {parserVersion:DOCUMENT_PARSER_VERSION,blocks,normalizedTextHash:payloadHash(blocks.map(b=>b.text)),
  coverage:{status:text?'partial':'unsupported',coveredBytes:0,totalBytes:bytes.length,gaps:bytes.length?[{rawStartByte:0,rawEndByte:bytes.length,reason:reason??notice}]:[]},
  documentNotice:notice};
}
