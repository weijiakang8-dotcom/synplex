// Fixed stdin-only bridge to the same sandboxed parser used for saved sources.
// Caller paths, URLs, commands, parser selection and credentials are not inputs.
import {createHash} from 'node:crypto';
import {DOCUMENT_FORMATS,documentExtension} from '../../public/document-formats.js';
import {parseDocument,extractSpreadsheetTable} from '../../packages/ingestion/documents.mjs';

const MAX_BYTES=8*1024*1024,MAX_INPUT=Math.ceil(MAX_BYTES*4/3)+4096;
try{
 const chunks=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>MAX_INPUT)throw Error();chunks.push(chunk);}
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['name','mediaType','sha256','contentBase64','table'].includes(k))||
    !['name','mediaType','sha256','contentBase64'].every(k=>typeof input[k]==='string')||input.name.length>240||
    !/^[a-f0-9]{64}$/.test(input.sha256))throw Error();
 const bytes=Buffer.from(input.contentBase64,'base64');
 if(!bytes.length||bytes.length>MAX_BYTES||bytes.toString('base64')!==input.contentBase64||createHash('sha256').update(bytes).digest('hex')!==input.sha256)throw Error();
 const extension=documentExtension(input.mediaType)??input.name.split('.').at(-1).toLowerCase();
 const format=DOCUMENT_FORMATS[extension];if(!format)throw Error();
 if(input.table!==undefined){
  if(!input.table||Object.keys(input.table).join(',')!=='sheetName'||typeof input.table.sheetName!=='string'||input.table.sheetName.length>200)throw Error();
  try{process.stdout.write(JSON.stringify({ok:true,table:await extractSpreadsheetTable(bytes,format,input.table.sheetName,{timeoutMs:20000})}));}
  catch(error){process.stdout.write(JSON.stringify({ok:false,message:error.message}));}
 }else{
  const parsed=await parseDocument(bytes,format,'1',input.sha256,'user-document',{timeoutMs:20000});
  if(!parsed?.blocks.length){process.stdout.write(JSON.stringify({ok:false,message:parsed?.documentNotice??'文件暂时无法读取，原件仍保留。'}));}
  else process.stdout.write(JSON.stringify({ok:true,text:parsed.blocks.map(b=>b.text).join('\n\n'),
   parserVersion:parsed.parserVersion,coverage:parsed.coverage,notice:parsed.documentNotice}));
 }
}catch{
 process.stdout.write(JSON.stringify({ok:false,message:'文件暂时无法读取，请检查原文件或转换为文字后重试；原件仍保留。'}));
}
