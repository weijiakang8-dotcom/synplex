// Adapted from the frozen Weave parser; original asset remains unchanged.
import { execFile } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { unzipSync, strFromU8 } from "fflate";

export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 1_000_000;
export const TEXT_FORMATS = new Set("txt md markdown json jsonl ndjson yaml yml toml ini cfg conf env xml html htm csv tsv log diff patch py js mjs cjs ts tsx jsx sql sh bash zsh css scss sass less java c cpp h hpp cs go rs rb php swift kt kts r vue svelte ipynb tex bib rst adoc dockerfile makefile gitignore properties graphql gql proto".split(" "));
// Future media adapters can implement this same interface without changing storage or jobs.

function entities(text       )        { return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi,(_,name       )=>{if(name[0]==="#"){const n=name[1].toLowerCase()==="x"?parseInt(name.slice(2),16):parseInt(name.slice(1),10);return n>0&&n<=0x10ffff?String.fromCodePoint(n):"";}return ({amp:"&",lt:"<",gt:">",quot:'"',apos:"'",nbsp:" "}                         )[name.toLowerCase()] || "";}); }
function markupText(text       )        { return entities(text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,"").replace(/<\/(?:p|div|h[1-6]|li|tr|table|text:p|text:h|a:p)>/gi,"\n").replace(/<(?:br|text:line-break)\b[^>]*\/?\s*>/gi,"\n").replace(/<\/?[^>]+>/g,"")).replace(/\n[ \t]+/g,"\n"); }
function decode(bytes           )        {
  let text       ;
  if(bytes[0]===0xff&&bytes[1]===0xfe)text=new TextDecoder("utf-16le").decode(bytes);
  else if(bytes[0]===0xfe&&bytes[1]===0xff)text=new TextDecoder("utf-16be").decode(bytes);
  else {try{text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);}catch{text=new TextDecoder("gb18030",{fatal:true}).decode(bytes);}}
  if(text.includes("\u0000"))throw new Error("文件包含二进制内容，无法按文本导入");
  return text.replace(/^\uFEFF/,"");
}
const crcTable = Uint32Array.from({length:256}, (_, index) => {
  let value=index;
  for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);
  return value>>>0;
});
function crc32(bytes           )        {
  let value=0xffffffff;
  for(const byte of bytes)value=crcTable[(value^byte)&255]^(value>>>8);
  return (value^0xffffffff)>>>0;
}
function archiveExtra(b       ,start       ,length       ) {
  const end=start+length;
  for(let pos=start;pos<end;) {
    if(pos+4>end)throw new Error("Office ZIP 附加字段损坏");
    const kind=b.readUInt16LE(pos),size=b.readUInt16LE(pos+2);
    if(kind===1)throw new Error("暂不支持 ZIP64 文档");
    pos+=4+size;
    if(pos>end)throw new Error("Office ZIP 附加字段损坏");
  }
}
function checkArchive(bytes           ) {
  const b=Buffer.from(bytes);let end=-1;
  for(let i=b.length-22;i>=Math.max(0,b.length-65557);i--) {
    if(b.readUInt32LE(i)===0x06054b50 && i+22+b.readUInt16LE(i+20)===b.length){end=i;break;}
  }
  if(end<0)throw new Error("Office 文件不是有效的 ZIP 文档");
  const count=b.readUInt16LE(end+10),diskCount=b.readUInt16LE(end+8);
  const start=b.readUInt32LE(end+16),size=b.readUInt32LE(end+12);
  if(count===0xffff||start===0xffffffff||size===0xffffffff||count>10000)throw new Error("Office 压缩目录过大或使用暂不支持的 ZIP64 格式");
  if(b.readUInt16LE(end+4)!==0||b.readUInt16LE(end+6)!==0||count!==diskCount)throw new Error("暂不支持分卷 ZIP 文档");
  if(start+size!==end)throw new Error("Office ZIP 压缩目录边界损坏");
  if(end>=20 && b.readUInt32LE(end-20)===0x07064b50)throw new Error("暂不支持 ZIP64 文档");
  let pos=start,total=0;
  const spans                            =[],names=new Set        ();
  for(let index=0;index<count;index++) {
    if(pos+46>end||b.readUInt32LE(pos)!==0x02014b50)throw new Error("Office 压缩目录损坏");
    const flags=b.readUInt16LE(pos+8),method=b.readUInt16LE(pos+10),crc=b.readUInt32LE(pos+16);
    const compressed=b.readUInt32LE(pos+20),uncompressed=b.readUInt32LE(pos+24);
    const nameLength=b.readUInt16LE(pos+28),extraLength=b.readUInt16LE(pos+30),commentLength=b.readUInt16LE(pos+32);
    const local=b.readUInt32LE(pos+42),next=pos+46+nameLength+extraLength+commentLength;
    if(next>end||b.readUInt16LE(pos+34)!==0)throw new Error("Office ZIP 压缩条目边界损坏");
    if([compressed,uncompressed,local].includes(0xffffffff))throw new Error("暂不支持 ZIP64 文档");
    if(flags&(1|64|8192))throw new Error("暂不支持加密 Office 文档");
    if(method!==0&&method!==8)throw new Error("Office ZIP 压缩方法暂不支持");
    const name=b.subarray(pos+46,pos+46+nameLength),key=name.toString("hex");
    if(names.has(key))throw new Error("Office ZIP 含重复文件名");
    names.add(key);archiveExtra(b,pos+46+nameLength,extraLength);
    total+=uncompressed;
    if(total>100*1024*1024)throw new Error("文档解压后超过 100MB，暂不导入");
    if(local+30>start||b.readUInt32LE(local)!==0x04034b50)throw new Error("Office ZIP 本地条目损坏");
    const localNameLength=b.readUInt16LE(local+26),localExtraLength=b.readUInt16LE(local+28);
    const dataStart=local+30+localNameLength+localExtraLength,dataEnd=dataStart+compressed;
    if(dataEnd>start||b.readUInt16LE(local+6)!==flags||b.readUInt16LE(local+8)!==method||!b.subarray(local+30,local+30+localNameLength).equals(name))throw new Error("Office ZIP 本地条目与目录不匹配");
    archiveExtra(b,local+30+localNameLength,localExtraLength);
    const localCrc=b.readUInt32LE(local+14),localCompressed=b.readUInt32LE(local+18),localUncompressed=b.readUInt32LE(local+22);
    let entryEnd=dataEnd;
    if(flags&8) {
      if((localCrc!==0&&localCrc!==crc)||(localCompressed!==0&&localCompressed!==compressed)||(localUncompressed!==0&&localUncompressed!==uncompressed))throw new Error("Office ZIP 数据描述与目录不匹配");
      let descriptor=dataEnd;
      if(descriptor+4<=start&&b.readUInt32LE(descriptor)===0x08074b50)descriptor+=4;
      if(descriptor+12>start||b.readUInt32LE(descriptor)!==crc||b.readUInt32LE(descriptor+4)!==compressed||b.readUInt32LE(descriptor+8)!==uncompressed)throw new Error("Office ZIP 数据描述损坏");
      entryEnd=descriptor+12;
    } else if(localCrc!==crc||localCompressed!==compressed||localUncompressed!==uncompressed)throw new Error("Office ZIP 本地大小或校验与目录不匹配");
    const segment=b.subarray(dataStart,dataEnd);
    let output       ;
    if(method===0) {
      if(compressed!==uncompressed)throw new Error("Office ZIP 存储大小不匹配");
      output=segment;
    } else {
      try {output=inflateRawSync(segment,{maxOutputLength:Math.max(1,uncompressed)});}
      catch {throw new Error("Office ZIP 解压失败或实际大小超过声明");}
    }
    if(output.length!==uncompressed||crc32(output)!==crc)throw new Error("Office ZIP 实际大小或 CRC 校验不匹配");
    spans.push({start:local,end:entryEnd});pos=next;
  }
  if(pos!==end)throw new Error("Office ZIP 目录计数与大小不匹配");
  spans.sort((a,b)=>a.start-b.start);
  for(let index=1;index<spans.length;index++)if(spans[index].start<spans[index-1].end)throw new Error("Office ZIP 本地条目重叠");
}
async function nativeWord(bytes           ,format       )                 {
  if(process.platform!=="darwin")throw new Error(`此系统未安装 ${format} 解析器，请转换为 DOCX；解析接口已预留`);
  return new Promise((resolve,reject)=>{const child=execFile("/usr/bin/textutil",["-convert","txt","-stdout","-format",format,"-stdin"],{timeout:20000,maxBuffer:MAX_TEXT_CHARS*4},(error,stdout)=>error?reject(new Error("Word 文件无法解析，请检查文件或转换为 DOCX")):resolve(stdout));child.stdin?.on("error",()=>{});child.stdin?.end(Buffer.from(bytes));});
}
function literalNumber(number){
  const digits=String(number).split(/[eE]/)[0].replace(/[^0-9]/g,'').replace(/^0+/,'').replace(/0+$/,'');
  if(typeof number!=='number'||!Number.isFinite(number)||Number.isInteger(number)&&!Number.isSafeInteger(number)||digits.length>15)throw new Error('表格含精度不明确的数值，请核对后将这些单元格另存为文字数字。');
  let value=String(number);
  if(/[eE]/.test(value)){
    const [coefficient,exponent]=value.toLowerCase().split('e'),negative=coefficient.startsWith('-'),parts=coefficient.replace(/^-/, '').split('.'),all=parts.join(''),point=parts[0].length+Number(exponent);
    value=(negative?'-':'')+(point<=0?'0.'+'0'.repeat(-point)+all:point>=all.length?all+'0'.repeat(point-all.length):all.slice(0,point)+'.'+all.slice(point));
  }
  return value;
}
function literalCell(cell){
  if(cell?.f!==undefined||cell?.F!==undefined)throw new Error('工作表含公式，不使用旧计算值；请核对后另存为数值表格。');
  if(!cell||cell.t==='z'||cell.v===undefined||cell.v===null)return '';
  if(cell.t==='s'||cell.t==='str')return String(cell.v);
  if(cell.t==='n')return literalNumber(cell.v);
  throw new Error('工作表含日期、真假值或错误单元格，请明确转换为需要统计的文字或数字。');
}
function spreadsheetRows(XLSX,sheet,range){
  const values=[];let characters=0;
  for(let r=range.s.r;r<=range.e.r;r++){
    const row=[];
    for(let c=range.s.c;c<=range.e.c;c++){
      const value=literalCell(sheet[XLSX.utils.encode_cell({r,c})]);
      characters+=value.length;if(value.length>10000||characters>1_000_000)throw new Error('表格内容超过本次计算容量，请拆分后处理。');
      row.push(value);
    }
    values.push(row);
  }
  const blank=row=>row.every(x=>!x.trim());
  const start=values.findIndex(row=>!blank(row));if(start<0)throw new Error('所选工作表没有可计算的记录。');
  let end=values.length;while(end>start&&blank(values[end-1]))end--;
  const rows=values.slice(start,end);
  if(rows.some(blank))throw new Error('工作表中有空白记录行，请先核对数据范围。');
  return {values:rows,range:{s:{r:range.s.r+start,c:range.s.c},e:{r:range.s.r+end-1,c:range.e.c}}};
}
// Structured literal cells for the existing table tool, not rendered CSV or
// cached formula values. Uses the same checked archive and isolated worker.
export async function parseSpreadsheetTable(bytes,extension,sheetName=''){
  if(!['xlsx','xls','xlsm'].includes(extension)||!bytes.length||bytes.length>MAX_FILE_BYTES||typeof sheetName!=='string'||sheetName.length>200)throw new Error('请选择普通Excel文件和要计算的工作表。');
  const XLSX=await import('xlsx');let book;
  try{
    if(extension==='xls'){
      if(Buffer.from(bytes).subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1')throw new Error();
    }else{
      if(bytes[0]!==0x50||bytes[1]!==0x4b)throw new Error();
      checkArchive(bytes);
    }
    book=XLSX.read(bytes,{type:'array',cellFormula:true,cellDates:true,cellText:false});
  }
  catch{throw new Error('表格文件损坏、已加密或暂时无法读取，请检查后另存为普通Excel文件。');}
  if(!sheetName&&book.SheetNames.length!==1)throw new Error('文件有多张工作表，请先明确要计算哪一张，不会自动合并。');
  const name=sheetName||book.SheetNames[0],sheet=book.Sheets[name];
  if(!sheet||!sheet['!ref'])throw new Error('没有找到所选工作表或其中没有表格数据。');
  const range=XLSX.utils.decode_range(sheet['!ref']),height=range.e.r-range.s.r+1,width=range.e.c-range.s.c+1;
  if(height>10001||width>50||range.s.r<0||range.s.c<0)throw new Error('表格超过一万行或五十列，请拆分后计算。');
  if(sheet['!merges']?.length)throw new Error('工作表含合并单元格，请先整理为每行一条记录的普通表格。');
  const {values,range:used}=spreadsheetRows(XLSX,sheet,range);
  const [header,...rows]=values;
  if(header.some(x=>!x.trim()||x.length>200)||new Set(header).size!==header.length)throw new Error('表格列名缺失、重复或过长，请核对第一行表头。');
  return {sheetName:name,range:XLSX.utils.encode_range(used),headerRow:used.s.r+1,header,rows,parserVersion:'synplex.literal-spreadsheet/1',
    notice:'首个非空行作为表头，开头和末尾留白不计入记录；只统计所选工作表保存的文字和数字，不执行公式、宏或外部链接，不包含其他工作表、图片和批注。数值单元格最多接受15位有效数字，更长数字需明确保存为文字。'};
}
const parsers                  = [
  {extensions:["pdf"],parse:async bytes=>{const {PDFParse}=await import("pdf-parse");// PDF.js transfers its input buffer to a worker; keep the immutable attachment intact.
const parser=new PDFParse({data:new Uint8Array(bytes),isEvalSupported:false});try{const info=await parser.getInfo();if(info.total>2000)throw new Error("PDF 超过 2000 页，请拆分后导入");const result=await parser.getText();if(!result.pages.some(p=>p.text.trim()))throw new Error("PDF 没有可提取的文字，扫描版需要后续 OCR，当前暂不接受");return result.pages.map(p=>`【第 ${p.num} 页】\n${p.text}`).join("\n\n");}finally{await parser.destroy();}}},
  {extensions:["docx"],parse:async bytes=>{checkArchive(bytes);const mammoth=await import("mammoth");return (await mammoth.extractRawText({buffer:Buffer.from(bytes)})).value;}},
  {extensions:["doc","rtf"],parse:async()=>""},
  {extensions:["odt"],parse:async bytes=>{checkArchive(bytes);const files=unzipSync(bytes,{filter:file=>file.name==="content.xml"});if(!files["content.xml"])throw new Error("ODT 正文不存在");return markupText(strFromU8(files["content.xml"]));}},
  {extensions:["pptx"],parse:async bytes=>{checkArchive(bytes);const files=unzipSync(bytes,{filter:file=>/^ppt\/slides\/slide\d+\.xml$/.test(file.name)});const names=Object.keys(files).sort((a,b)=>Number(a.match(/slide(\d+)/)?.[1])-Number(b.match(/slide(\d+)/)?.[1]));return names.map((name,i)=>`【幻灯片 ${i+1}】\n${markupText(strFromU8(files[name]))}`).join("\n\n");}},
  {extensions:["xlsx","xls","xlsm"],parse:async bytes=>{if(bytes[0]===0x50&&bytes[1]===0x4b)checkArchive(bytes);const XLSX=await import("xlsx");const workbook=XLSX.read(bytes,{type:"array",cellFormula:true});let total=0;return workbook.SheetNames.map(name=>{const sheet=workbook.Sheets[name];const ref=sheet["!ref"];if(ref){const range=XLSX.utils.decode_range(ref);if((range.e.r+1)*(range.e.c+1)>250000)throw new Error("表格单元格范围超过 25 万，请拆分后导入");}const csv=XLSX.utils.sheet_to_csv(sheet);total+=csv.length;if(total>MAX_TEXT_CHARS)throw new Error("表格文本超过 100 万字符，请拆分后导入");const formulas=Object.entries(sheet).filter(([key,value])=>!key.startsWith("!")&&(value               ).f).map(([key,value])=>`${key}: ${(value              ).f}`);return `【工作表：${name}】\n${csv}${formulas.length?"\n【原有公式，不执行或重算】\n"+formulas.join("\n"):""}`;}).join("\n\n");}}
];
export const SUPPORTED_FORMATS = [...TEXT_FORMATS,...parsers.flatMap(p=>p.extensions)];
export async function parseLibraryFile(filename       ,bytes           )                                                          {
  if(!bytes.length||bytes.length>MAX_FILE_BYTES)throw new Error("文件为空或超过 20MB");
  const name=filename.split(/[\\/]/).pop()?.replace(/[\u0000-\u001f]/g,"").slice(0,240)||"未命名.txt";
  const lower=name.toLowerCase();const format=lower.includes(".")?lower.split(".").pop() :lower;
  if(!SUPPORTED_FORMATS.includes(format))throw new Error("暂不支持此格式；支持文本、代码、PDF、Word、表格和 PPTX，图片与录像留待后续");
  let original       ;
  if(format==="doc"||format==="rtf")original=await nativeWord(bytes,format);
  else if(TEXT_FORMATS.has(format)){original=decode(bytes);if(format==="html"||format==="htm")original=markupText(original);}
  else original=await parsers.find(p=>p.extensions.includes(format)) .parse(bytes);
  if(!original.trim())throw new Error("文档没有可提取的文字");
  if(original.length>MAX_TEXT_CHARS)throw new Error("解析文本超过 100 万字符，请拆分后导入");
  return {original,format,filename:name};
}
