import {sha256,ProtocolError} from '../../packages/contracts/validate.mjs';

// Retain the exact document's own dated preamble, not its import/mtime date.
// Native conversation events deliberately cannot borrow a neighboring event.
export function sourcePreambles(repository,auth,scope,spans){
 if(!Array.isArray(spans)||spans.length>24)throw new ProtocolError('validation_failed','资料范围过大。','缩小本次资料范围。');
 const result=[],seen=new Set();
 for(const span of spans){
  if(seen.has(span.occurrenceId))continue;seen.add(span.occurrenceId);
  const occurrence=repository.read(auth,scope,'occurrence',span.occurrenceId),source=repository.read(auth,scope,'source',span.sourceId);
  if(!occurrence||occurrence.sourceId!==span.sourceId||occurrence.parsedRevisionId!==span.parsedRevisionId||!source)throw new ProtocolError('scope_denied','无法核对资料出处。','选择当前项目资料。');
  if(!['text/markdown','text/plain'].includes(source.format))continue;
  const parsed=repository.read(auth,scope,'parsed',span.parsedRevisionId);
  if(!parsed||parsed.sourceId!==source.id)throw new ProtocolError('scope_denied','资料版本无法核对。','核对原资料。');
  for(const block of parsed.blocks.slice(0,4)){
   if(block.text.length>1000||!/(?:created|updated|date|日期|时间|记录于|测量日)[^\n]{0,40}20\d{2}[-年/.]/i.test(block.text))continue;
   result.push({...span,blockId:block.id,start:0,end:block.text.length,quote:block.text,quoteHash:sha256(Buffer.from(block.text))});
  }
 }
 return result;
}
