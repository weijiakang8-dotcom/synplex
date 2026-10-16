import {payloadHash,validateEvidence,ProtocolError} from '../../packages/contracts/validate.mjs';

function checkSpan(repository,auth,scope,span){
 const denied=()=>{throw new ProtocolError('scope_denied','原对话的参考资料无法核对。','保留原对话，重新选择当前项目资料。');};
 const parsed=repository.read(auth,scope,'parsed',span.parsedRevisionId),occurrence=repository.read(auth,scope,'occurrence',span.occurrenceId);
 if(!parsed||!occurrence||parsed.sourceId!==span.sourceId||occurrence.sourceId!==span.sourceId||occurrence.parsedRevisionId!==parsed.id)denied();
 const block=parsed.blocks.find(b=>b.id===span.blockId);if(!block)denied();
 const source=repository.read(auth,scope,'source',span.sourceId);
 if(!source||source.format==='application/x-ndjson'&&!repository.read(auth,scope,'occurrence_blocks',occurrence.id)?.blockIds.includes(block.id))denied();
 validateEvidence(span,block);
}

// Carry original quoted evidence, never promote an assistant answer to a fact.
// A title mentioned by a model is admitted only if that turn really received
// the source and its exact quote still validates in the current project.
export function conversationEvidence(repository,auth,scope,reference){
 if(!reference)return [];
 const chat=repository.chat(auth,scope),groups=new Map(),seen=new Set();
 for(const turn of reference.turns){
  if(turn.status!=='completed')continue;
  const original=chat.get(turn.id),background=original.background;
  if(!background)continue;
  for(const ref of background.sourceReferences??[]){
   const names=[ref.title,ref.path?.split('/').at(-1)].filter(Boolean);
   if(!names.some(name=>turn.answer?.includes(name)))continue;
   for(const span of background.evidence.filter(e=>e.sourceId===ref.sourceId)){
    const key=payloadHash(span);if(seen.has(key))continue;seen.add(key);
    checkSpan(repository,auth,scope,span);
    if(!groups.has(span.sourceId))groups.set(span.sourceId,[]);groups.get(span.sourceId).push(span);
   }
  }
 }
 // One long cited source cannot crowd out every other source.
 const result=[],pages=[...groups.values()];
 for(let i=0;i<24;i++)for(const page of pages)if(page[i])result.push(page[i]);
 return result;
}

// An unchanged old manuscript still needs the sources from its original task.
// A result's words locate citations; only validated original spans are evidence.
export function taskEvidence(repository,auth,scope,inputs=[]){
 const spans=[],seen=new Set();
 for(const input of inputs){
  const result=repository.read(auth,scope,'result',input.resultId);
  if(!result||result.payloadHash!==input.resultHash)throw new ProtocolError('scope_denied','原成果已变化，不能沿用其参考资料。','核对原成果版本。');
  const attempt=repository.read(auth,scope,'attempt',result.attemptId),run=attempt&&repository.read(auth,scope,'run',attempt.runId);
  const packet=run&&repository.read(auth,scope,'context',run.contextPacketId);
  if(!packet)throw new ProtocolError('scope_denied','无法核对原任务的参考资料。','保留原成果，核对原任务。');
  const cited=new Set((packet.sourceReferences??[]).filter(ref=>[ref.title,ref.path?.split('/').at(-1)].filter(Boolean).some(name=>result.summary.includes(name))).map(ref=>ref.sourceId));
  for(const span of packet.evidence.filter(e=>cited.has(e.sourceId))){
   const key=payloadHash(span);if(seen.has(key))continue;
   checkSpan(repository,auth,scope,span);seen.add(key);spans.push(span);
  }
 }
 return spans;
}
