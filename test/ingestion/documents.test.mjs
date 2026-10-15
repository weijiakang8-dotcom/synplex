import {materialQuestionInput} from '../../public/material-question.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import {documentFixtures} from '../../scripts/testing/document-fixtures.mjs';
import {DOCUMENT_FORMATS,uploadFormat} from '../../public/document-formats.js';
import {importSource} from '../../packages/ingestion/index.mjs';
import {parseDocument,extractSpreadsheetTable} from '../../packages/ingestion/documents.mjs';
import {setup,meta,input} from './helpers.mjs';
import {sha256,validateEvidence} from '../../packages/contracts/validate.mjs';
import {createWorkspaceServer} from '../../services/workspace/http.mjs';
import * as ingestion from '../../packages/ingestion/index.mjs';
import {execFileSync} from 'node:child_process';
import {writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {documentSandboxProfile} from '../../packages/ingestion/documents.mjs';

test('多格式真实文件经HTTP导入、提取预览、原件下载和持久引用，格式不冒充完整解析',async t=>{
 const h=await setup(t),app=createWorkspaceServer({repository:h.repository,modules:{ingestion}}),url=await app.listen();
 t.after(()=>app.close());
 const pair=await app.createUiPairing(h.auth,h.repo.scope),login=await fetch(url+'/api/v1/ui_pair',{method:'POST',body:new URLSearchParams({pair:pair.nonce}),redirect:'manual'}),cookie=login.headers.get('set-cookie').split(';')[0];
 const post=(route,extra)=>fetch(url+'/api/v1/'+route,{method:'POST',headers:{Cookie:cookie,'Content-Type':'application/json'},body:JSON.stringify({protocolVersion:'synplex.workspace/1.0.0',scope:h.repo.scope,...extra})}),previews=[];
 for(const [extension,bytes] of Object.entries(documentFixtures())){
  const state=await h.repo.getState(),metadata={protocolVersion:'synplex.workspace/1.0.0',scope:h.repo.scope,requestId:'file-'+extension,expectedStateRevision:state.stateRevision,...uploadFormat('source.'+extension),sessionId:null,eventId:'event-'+extension,occurredAt:null};
  const body=new FormData();body.set('metadata',JSON.stringify(metadata));body.set('source',new Blob([bytes]),'source.'+extension);
  const admission=await fetch(url+'/api/v1/import_source',{method:'POST',headers:{Cookie:cookie},body});assert.equal(admission.status,202);
  const {operation}=await admission.json();await app.service.idle();
  const response=await post('get_import_result',{operationId:operation.id});assert.equal(response.status,200);const out=(await response.json()).result;
  assert.equal(out.outcome,'partial',extension+': '+JSON.stringify(out));assert.equal(out.parsed.coverage.coveredBytes,0);
  assert.equal(out.parsed.blocks.length,1);assert.equal(out.parsed.blocks[0].rawEndByte,bytes.length);
  const preview=await post('ui_source_preview',{sourceId:out.source.id});assert.equal(preview.status,200);const detail=await preview.json(),text=detail.parsed.blocks[0].text;previews.push(detail);assert.equal(detail.occurrenceId,out.occurrences.at(-1).id);const question=new FormData();question.set('question','资料说明了什么？');const task=materialQuestionInput(detail,question);assert.deepEqual(task.selectedOccurrenceIds,[detail.occurrenceId]);assert.equal(task.mode,'host_assist');
  assert.match(text,/保留原件|preserve originals/);
  if(extension==='pdf')assert.match(text,/第 1 页/);
  if(extension==='pptx')assert.ok(text.indexOf('第一页')<text.indexOf('第二页'));
  if(['xlsx','xls','xlsm'].includes(extension)){assert.match(text,/工作表：费用/);assert.match(text,/,5/);if(extension!=='xls'){assert.match(text,/SUM\(B2:B3\)/);assert.match(text,/不执行或重算/);}}
  const download=await post('source_file',{sourceId:out.source.id});assert.equal(download.status,200);assert.match(download.headers.get('content-disposition'),new RegExp('\\.'+extension+'"$'));assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
  const candidates=(await h.repo.getState()).pending.filter(c=>c.evidence.some(e=>e.sourceId===out.source.id));assert.ok(candidates.length);
  for(const candidate of candidates){const evidence=candidate.evidence[0];validateEvidence(evidence,out.parsed.blocks[0]);assert.equal(text.slice(evidence.start,evidence.end),evidence.quote);assert.equal(sha256(Buffer.from(evidence.quote)),evidence.quoteHash);}
  assert.equal((await post('ui_source_preview',{sourceId:out.source.id,scope:{...h.repo.scope,projectId:'foreign'}})).status,403);
 }
 const question=new FormData();question.set('question','比较这些资料的出处与结论。');
 assert.deepEqual(materialQuestionInput(previews,question).selectedOccurrenceIds,previews.map(p=>p.occurrenceId));
 assert.deepEqual(materialQuestionInput(previews.map(p=>({occurrenceId:p.occurrenceId,blockCount:p.parsed.blocks.length})),question).selectedOccurrenceIds,previews.map(p=>p.occurrenceId));
 assert.throws(()=>materialQuestionInput([previews[0],previews[0]],question),/只需选择一次/);
 assert.throws(()=>materialQuestionInput([],question),/一至三十份/);
 assert.throws(()=>materialQuestionInput(Array.from({length:31},(_,i)=>({occurrenceId:'event-'+i,blockCount:1})),question),/一至三十份/);
 await app.close();await h.reopen();assert.equal(h.repository.list(h.auth,h.repo.scope,'source').length,Object.keys(documentFixtures()).length);
});

test('损坏、无文字、超限与超时文件保留原件且没有假引用；旧文本导入不变',async t=>{
 const h=await setup(t);
 await assert.rejects(extractSpreadsheetTable(Buffer.from('收入\n1\n'),DOCUMENT_FORMATS.xlsx),/文件损坏|无法读取/,'文字改扩展名不能冒充Excel数值表');
 const blankPdf=Buffer.from(documentFixtures().pdf.toString().replace('Decision: preserve originals.',' '.repeat('Decision: preserve originals.'.length)));
 for(const [extension,bytes] of [['pdf',blankPdf],['docx',Buffer.from('broken')],['pdf',Buffer.alloc(20*1024*1024+1)]]){
  const out=await importSource(h.repo,input(bytes,{format:DOCUMENT_FORMATS[extension],sourceSystem:'user-document'}),await meta(h.repo));
  assert.equal(out.parsed.coverage.status,'unsupported');assert.equal(out.parsed.blocks.length,0);assert.ok(out.warnings.length);const question=new FormData();question.set('question','读一下');assert.throws(()=>materialQuestionInput({occurrenceId:out.occurrences.at(-1)?.id,parsed:out.parsed},question),/没有可读取/);
  assert.deepEqual(Buffer.from((await h.repo.getBlob(out.source.id)).bytes),bytes);
 }
 const bytes=documentFixtures().pptx,timeout=await parseDocument(bytes,DOCUMENT_FORMATS.pptx,'1',sha256(bytes),'user-document',{timeoutMs:1});
 assert.equal(timeout.coverage.status,'unsupported');assert.match(timeout.documentNotice,/超时/);
 const text=await importSource(h.repo,input('决定：旧文字仍可读取。'),await meta(h.repo));assert.equal(text.parsed.coverage.status,'complete');
 if(process.platform==='darwin'){
  const sentinel=join(h.dataDir,'private-sentinel');writeFileSync(sentinel,'only-fixture-no-real-secret');
  const code=`import fs from 'node:fs';import net from 'node:net';let deniedRead=false,deniedWrite=false;try{fs.readFileSync(${JSON.stringify(sentinel)});}catch(e){deniedRead=['EPERM','EACCES'].includes(e.code);}try{fs.writeFileSync(${JSON.stringify(sentinel)},'changed');}catch(e){deniedWrite=['EPERM','EACCES'].includes(e.code);}const socket=net.createConnection({host:'127.0.0.1',port:9});socket.on('error',e=>{console.log(JSON.stringify({deniedRead,deniedWrite,deniedNetwork:['EPERM','EACCES'].includes(e.code)}));});`;
  const check=execFileSync('/usr/bin/sandbox-exec',['-p',documentSandboxProfile(),process.execPath,'--input-type=module','-e',code],{cwd:new URL('../../packages/ingestion/',import.meta.url),env:{PATH:'/usr/bin:/bin'},timeout:5000,stdio:['pipe','pipe','pipe']});
  assert.deepEqual(JSON.parse(check.toString()),{deniedRead:true,deniedWrite:true,deniedNetwork:true});
 }
});
