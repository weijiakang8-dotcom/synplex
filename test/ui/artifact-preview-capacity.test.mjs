import test from 'node:test';
import assert from 'node:assert/strict';
import {createDocumentReader,previewArtifact} from '../../services/workspace/artifact-preview.mjs';
import {documentFixtures} from '../../scripts/testing/document-fixtures.mjs';
import {DOCUMENT_FORMATS} from '../../public/document-formats.js';
import {sha256} from '../../packages/contracts/validate.mjs';
import {errorText} from '../../public/user-copy.js';

test('成果文档读取有界，同原件等待合并但成果身份独立；超量与读取失败不占死槽位',async()=>{
 const started=[],release=new Map();let running=0,peak=0;
 const reader=createDocumentReader(async(bytes,format,version,hash)=>{
  started.push(hash);peak=Math.max(peak,++running);
  try{return await new Promise((resolve,reject)=>release.set(hash,{resolve,reject}));}finally{running--;}
 });
 const file=(hash,resultId)=>({receipt:{artifactId:resultId+'-file',resultId,name:resultId+'.docx',sha256:hash,byteLength:1,mediaType:DOCUMENT_FORMATS.docx},bytes:Buffer.from(hash)});
 const parsed={blocks:[{text:'只用于并发调度验证的提取夹具'}],documentNotice:'提取范围需核对'};
 const reads=['a','b','c','d'].map(hash=>previewArtifact(file(hash,hash),reader));
 const duplicate=previewArtifact(file('a','other-result'),reader);
 await assert.rejects(previewArtifact(file('e','too-many'),reader),error=>{
  assert.equal(error.code,'capability_unavailable');assert.equal(error.retry,'after_input');const message=errorText(error);
  assert.match(message,/稍后再打开.*无需重新执行/);assert.equal(errorText(Object.assign(new Error(message),{code:error.code})),message,'请求层与通知层再次格式化仍说明真正原因');
  assert.match(errorText({code:error.code,message:'raw SQL details'}),/工具尚未连接或暂时不可用/);return true;
 });
 assert.deepEqual(started,['a','b']);assert.equal(peak,2);
 release.get('a').resolve(parsed);const [a,other]=await Promise.all([reads[0],duplicate]);
 assert.equal(a.resultId,'a');assert.equal(other.resultId,'other-result');assert.equal(other.artifactId,'other-result-file');assert.equal(other.text,a.text);
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['a','b','c']);
 const failed=assert.rejects(reads[1],/synthetic parser fault/);release.get('b').reject(new Error('synthetic parser fault'));await failed;
 await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(started,['a','b','c','d']);
 release.get('c').resolve(parsed);release.get('d').resolve(parsed);await Promise.all([reads[2],reads[3]]);assert.equal(running,0);
 // Neither a previous failure nor an earlier completed extraction is cached.
 const retry=previewArtifact(file('b','retry-result'),reader),again=previewArtifact(file('a','fresh-result'),reader);
 assert.deepEqual(started.slice(-2),['b','a']);release.get('b').resolve(parsed);release.get('a').resolve(parsed);await Promise.all([retry,again]);assert.equal(running,0);assert.equal(peak,2);
});

test('真实Word原件仍经原受限读取器预览，原字节与身份不改变',async()=>{
 const bytes=documentFixtures().docx,hash=sha256(bytes),receipt={artifactId:'real-docx',resultId:'real-result',name:'交付说明.docx',sha256:hash,byteLength:bytes.length,mediaType:DOCUMENT_FORMATS.docx};
 const preview=await previewArtifact({receipt,bytes});
 assert.equal(preview.status,'extracted');assert.ok(preview.text.trim());assert.match(preview.notice,/图片、排版/);
 assert.equal(preview.resultId,receipt.resultId);assert.equal(preview.artifactId,receipt.artifactId);assert.equal(preview.sha256,hash);assert.equal(sha256(bytes),hash);
});
