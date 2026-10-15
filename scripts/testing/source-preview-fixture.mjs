import {randomUUID} from 'node:crypto';
import {sha256,payloadHash} from '../../packages/contracts/validate.mjs';
const meta=async repo=>({requestId:randomUUID(),expectedStateRevision:(await repo.getState()).stateRevision});

export async function previewSourceFixture(repo){
 const texts=['开头🙂\0保留零字符。'+('中🙂A').repeat(19000),...Array.from({length:43},(_,i)=>`段落${i}：<script>不执行</script>\n`),'最后一段：完整内容仍在。'];
 const bytes=Buffer.from(texts.join('')),source=(await repo.saveBlob({bytes,format:'text/plain'},await meta(repo))).value;
 let position=0;
 const blocks=texts.map((text,index)=>{const start=position;position+=Buffer.byteLength(text);return {id:'block-'+index,text,rawStartByte:start,rawEndByte:position};});
 const parsed=(await repo.appendParsedRevisions([{sourceId:source.id,parserVersion:'preview-fixture/1',normalizedTextHash:payloadHash(texts),blocks,coverage:{status:'complete',coveredBytes:bytes.length,totalBytes:bytes.length,gaps:[]}}],await meta(repo))).value[0];
 const event=(await repo.appendOccurrences([{sourceId:source.id,parsedRevisionId:parsed.id,externalSystem:'isolated-test',formatVersion:'1',sessionId:null,eventId:randomUUID(),seq:null,importOrigin:'isolated_test',occurredAt:null,payloadHash:sha256(bytes)}],await meta(repo))).value[0];
 return {texts,bytes,source,parsed,event};
}
