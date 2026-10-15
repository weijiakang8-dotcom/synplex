import {ProtocolError} from '../../packages/contracts/validate.mjs';
const invalid=()=>{throw new ProtocolError('validation_failed','补充问题格式不支持。','核对执行工具的问题，密钥请使用专门的凭据入口。');};
const text=(x,max)=>typeof x==='string'&&x.trim().length>0&&x.length<=max;
function validApproval(prompt){
 const a=prompt.approval;if(a===undefined)return true;
 return a&&/^[a-f0-9]{64}$/.test(a.snapshotHash)&&prompt.itemId===a.snapshotHash&&
  Array.isArray(a.operations)&&a.operations.length>0&&a.operations.length<=10&&
  a.operations.every(o=>text(o.tool,160)&&o.params&&typeof o.params==='object'&&!Array.isArray(o.params))&&
  Buffer.byteLength(JSON.stringify(a.operations))<=32000&&prompt.questions.length===1&&prompt.questions[0].id==='approval'&&
  prompt.questions[0].isOther===false&&JSON.stringify(prompt.questions[0].options?.map(o=>o.label))===JSON.stringify(['拒绝操作','允许这次操作']);
}
function validateEnvelope(prompt){
  if(!prompt||!text(prompt.remoteRequestId,128)||!text(prompt.threadId,256)||!text(prompt.turnId,256)||
    !text(prompt.itemId,256)||!Array.isArray(prompt.questions)||!prompt.questions.length||prompt.questions.length>3)invalid();
  if(!validApproval(prompt))invalid();
}
export function validateQuestion(prompt){
  validateEnvelope(prompt);
  const ids=new Set();
  for(const q of prompt.questions){
    if(!text(q.id,128)||ids.has(q.id)||!text(q.question,4000)||!text(q.header,128)||q.isSecret||
      typeof q.isOther!=='boolean'||q.options!==null&&(!Array.isArray(q.options)||q.options.length>8||q.options.some(o=>!text(o.label,512)||typeof o.description!=='string'||o.description.length>2000)))invalid();
    ids.add(q.id);
  }
  return structuredClone(prompt);
}
export function validateAnswers(prompt,answers){
  if(!answers||typeof answers!=='object'||Array.isArray(answers)||Object.keys(answers).length!==prompt.questions.length)invalid();
  for(const q of prompt.questions){
    const a=answers[q.id];
    if(!a||Object.keys(a).join(',')!=='answers'||!Array.isArray(a.answers)||a.answers.length!==1||!text(a.answers[0],8000))invalid();
    if(q.options?.length&&!q.isOther&&!q.options.some(o=>o.label===a.answers[0]))invalid();
  }
  return structuredClone(answers);
}
