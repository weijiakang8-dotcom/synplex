import {parseDocument} from '../../packages/ingestion/documents.mjs';
import {documentExtension} from '../../public/document-formats.js';
import {ProtocolError} from '../../packages/contracts/validate.mjs';

// Bound the private reader subprocesses, including concurrent version compares.
// Shared promises contain only the extraction; result identity stays per request.
// No completed private content is cached after the last pending read settles.
export function createDocumentReader(parse=parseDocument){
 let active=0;const waiting=[],pending=new Map();
 async function read(args){
  if(active>=2){
   if(waiting.length>=2)throw new ProtocolError('capability_unavailable','当前正在读取多份成果，请稍后再打开。','原文件和任务仍保留，无需重新执行。','after_input');
   await new Promise(resolve=>waiting.push(resolve));
  }else active++;
  try{return await parse(...args);}
  finally{const next=waiting.shift();if(next)next();else active--;}
 }
 return async(...args)=>{
  const key=JSON.stringify([args[1],args[2],args[3],args[4]]);
  if(pending.has(key))return pending.get(key);
  const promise=read(args);pending.set(key,promise);
  try{return await promise;}finally{if(pending.get(key)===promise)pending.delete(key);}
 };
}
const readDocument=createDocumentReader();

// Read-only, bounded projection. Never execute HTML, macros, code or remote URIs.
export async function previewArtifact({receipt,bytes},read=readDocument){
 const base={artifactId:receipt.artifactId,resultId:receipt.resultId,name:receipt.name,sha256:receipt.sha256,byteLength:receipt.byteLength,mediaType:receipt.mediaType};
 const format=documentExtension(receipt.mediaType)?receipt.mediaType:null;
 if(format){
  const parsed=await read(bytes,format,'1',receipt.sha256,'isolated-test');
  return {...base,status:parsed.blocks.length?'extracted':'unavailable',text:parsed.blocks.map(b=>b.text).join('\n\n'),notice:parsed.documentNotice};
 }
 if(/^(?:text\/|application\/(?:json|x-ndjson|xml))/.test(receipt.mediaType)||/\.(?:md|txt|csv|tsv|json|jsonl|py|js|ts|css|html|sql)$/i.test(receipt.name)){
  if(bytes.length>2*1024*1024)return {...base,status:'unavailable',text:'',notice:'这份文字较长，请下载完整文件查看；原文件仍保留。'};
  try{return {...base,status:'complete',text:new TextDecoder('utf-8',{fatal:true}).decode(bytes),notice:'完整文字。代码和网页只显示原文，不会运行。'};}
  catch{return {...base,status:'unavailable',text:'',notice:'这份文件不是可直接读取的中文文字，请下载原文件查看。'};}
 }
 return {...base,status:'unavailable',text:'',notice:'这类文件请下载后用对应的软件打开，原文件仍保留。'};
}
