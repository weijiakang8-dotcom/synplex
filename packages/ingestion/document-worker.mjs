import {parseLibraryFile,parseSpreadsheetTable, MAX_FILE_BYTES} from './document-parsers.mjs';
// One document per process, stdin only. No user-controlled path is opened.
const chunks=[];let size=0;
for await (const chunk of process.stdin) {
 size+=chunk.length;
 if(size>Math.ceil(MAX_FILE_BYTES*4/3)+4096)throw new Error('文件超过读取上限，请拆分后再导入。');
 chunks.push(chunk);
}
try {
 const input=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 if(input.table!==undefined){
  if(!input.table||Object.keys(input.table).join(',')!=='sheetName')throw new Error('工作表选择不完整。');
  process.stdout.write(JSON.stringify({ok:true,table:await parseSpreadsheetTable(Buffer.from(input.base64,'base64'),input.extension,input.table.sheetName)}));
 }else{
  const result=await parseLibraryFile(`source.${input.extension}`,Buffer.from(input.base64,'base64'));
  process.stdout.write(JSON.stringify({ok:true,text:result.original}));
 }
} catch(error) {
 process.stdout.write(JSON.stringify({ok:false,message:String(error.message).slice(0,500)}));
}
