import {zipSync,strToU8} from 'fflate';
import * as XLSX from 'xlsx';
import {execFileSync} from 'node:child_process';
const archive=files=>Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([name,text])=>[name,strToU8(text)]))));
export function literalSpreadsheetFixture(){
 const book=XLSX.utils.book_new();
 const income=XLSX.utils.sheet_add_aoa({},[['分类','收入'],['房费',0.1],['房费',0.2],['=不执行公式',1.25],['小额',1e-7],['长数','123456789012345678901234567890.12']],{origin:'A3'});
 XLSX.utils.book_append_sheet(book,income,'收入');
 const formula=XLSX.utils.aoa_to_sheet([['收入'],[2]]);formula.A2.f='1+1';XLSX.utils.book_append_sheet(book,formula,'公式');
 const merged=XLSX.utils.aoa_to_sheet([['分类','收入'],['房费',1]]);merged['!merges']=[{s:{r:0,c:0},e:{r:0,c:1}}];XLSX.utils.book_append_sheet(book,merged,'合并');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['收入'],[0.30000000000000004]]),'精度不明');
 XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['日期'],[new Date('2026-10-15T00:00:00Z')]],{cellDates:true}),'日期');
 return Buffer.from(XLSX.write(book,{type:'buffer',bookType:'xlsx'}));
}
export function documentFixtures() {
 const docx=archive({
  '[Content_Types].xml':'<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  'word/document.xml':'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>决定：保留原件，修订另外保存。</w:t></w:r></w:p></w:body></w:document>'
 });
 const pptx=archive({'ppt/slides/slide2.xml':'<a:p xmlns:a="a"><a:t>第二页：验证引用。</a:t></a:p>','ppt/slides/slide1.xml':'<a:p xmlns:a="a"><a:t>第一页：保留原件。</a:t></a:p>'});
 const workbook=XLSX.utils.book_new(),sheet=XLSX.utils.aoa_to_sheet([['决定','金额'],['保留原件',2],['不重算',3]]);
 sheet.B4={t:'n',v:5,f:'SUM(B2:B3)'};sheet['!ref']='A1:B4';XLSX.utils.book_append_sheet(workbook,sheet,'费用');
 // A real minimal text PDF, with byte-accurate cross-reference offsets.
 const stream='BT /F1 12 Tf 50 100 Td (Decision: preserve originals.) Tj ET';
 const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
 let pdf='%PDF-1.4\n';const offsets=[0];
 objects.forEach((object,i)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${object}\nendobj\n`;});
 const start=Buffer.byteLength(pdf);pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(x=>String(x).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
 const rtf=Buffer.from('{\\rtf1\\ansi Decision: preserve originals.}');
 return {pdf:Buffer.from(pdf),docx,pptx,xlsx:Buffer.from(XLSX.write(workbook,{type:'buffer',bookType:'xlsx'})),
  xls:Buffer.from(XLSX.write(workbook,{type:'buffer',bookType:'biff8'})),xlsm:Buffer.from(XLSX.write(workbook,{type:'buffer',bookType:'xlsm'})),
  odt:archive({'content.xml':'<office:document xmlns:office="o" xmlns:text="t"><text:p>决定：保留原件。</text:p></office:document>'}),
  ...(process.platform==='darwin'?{rtf,doc:execFileSync('/usr/bin/textutil',['-convert','doc','-stdout','-format','rtf','-stdin'],{input:rtf,timeout:5000})}:{})};
}
