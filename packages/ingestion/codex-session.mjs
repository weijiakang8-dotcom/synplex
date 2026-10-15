import {sha256,payloadHash} from '../contracts/validate.mjs';
export const CODEX_SESSION_VERSION='codex.session-jsonl/1';
export const CODEX_SESSION_PARSER='synplex.codex-session/1.0.0';
const decoder=new TextDecoder('utf-8',{fatal:true});
const metadataTypes=new Set(['session_meta','turn_context']);
const eventMetadata=new Set(['token_count','task_started','task_complete','turn_aborted','context_compacted','item_completed','item_started']);
const stamp=x=>typeof x==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(x)&&Number.isFinite(Date.parse(x))?new Date(x).toISOString():null;

// Explicit snapshot import, never a hook into a live host. IDs identify the
// uploaded snapshot/line; original host IDs remain in the immutable raw file.
export function parseCodexSession(bytes,sourceHash=sha256(bytes)){
 const blocks=[],records=[],gaps=[],roles=new Map(),candidateEligible=new Map(),recent=new Map();let sessionId=null,start=0,seq=0;
 function gap(end,reason){gaps.push({rawStartByte:start,rawEndByte:end,reason});}
 for(let i=0;i<=bytes.length;i++){
  if(i!==bytes.length&&bytes[i]!==10)continue;if(i===bytes.length&&start===i)break;
  const end=i<bytes.length?i+1:i,line=bytes.subarray(start,end);seq++;
  try{
   if(line.length>2*1024*1024)throw new Error('event_line_too_large');
   const text=decoder.decode(line);if(!text.trim()){start=end;continue;}
   const value=JSON.parse(text),p=value?.payload;if(!value||typeof value!=='object'||!p||typeof p!=='object')throw new Error('unsupported_event_shape');
   if(metadataTypes.has(value.type)){
    if(value.type==='session_meta'){
     const current=p.session_id??p.id;if(typeof current!=='string'||!current||sessionId&&sessionId!==current){sessionId=null;throw new Error('session_identity_conflict');}sessionId=current;
    }
    start=end;continue;
   }
   if(value.type==='event_msg'&&eventMetadata.has(p.type)){start=end;continue;}
   let body,role;
   if(value.type==='event_msg'&&['user_message','agent_message'].includes(p.type)&&typeof p.message==='string'){
    body=p.message;role=p.type==='user_message'?'user':'assistant';
   }else if(value.type==='response_item'&&p.type==='message'&&['user','assistant','developer','system'].includes(p.role)){
    if(!Array.isArray(p.content)||!p.content.length||p.content.some(c=>!['input_text','output_text'].includes(c.type)||typeof c.text!=='string'))throw new Error('unsupported_message_content');
    body=p.content.map(c=>c.text).join('\n');role=p.role;
   }else if(value.type==='response_item'&&['function_call','function_call_output','custom_tool_call','custom_tool_call_output'].includes(p.type)){
    // Preserve tool requests/results as ordinary historical text, never commands.
    body=JSON.stringify(p,null,2);role=p.type.endsWith('_output')?'tool_result':'tool_request';
   }else throw new Error('unsupported_event_type');
   if(!sessionId)throw new Error('session_identity_missing');
   const block={id:'block:'+payloadHash({sourceHash,parser:CODEX_SESSION_PARSER,start,end,text:body}),text:body,rawStartByte:start,rawEndByte:end};
   blocks.push(block);roles.set(block.id,role);
   const at=stamp(value.timestamp),key=payloadHash({role,body}),prior=recent.get(key);
   const duplicate=prior&&prior.kind!==value.type&&seq-prior.seq<=3&&at&&prior.at&&Math.abs(Date.parse(at)-Date.parse(prior.at))<=2000;
   // Keep all original blocks/occurrences. Harness rules and tool requests are
   // evidence to inspect, not project decisions for a human to review.
   const toolFailure=role==='tool_result'&&/(?:"status"\s*:\s*"(?:failed|error)"|exit(?:ed)?(?:\s+with)?\s+(?:code[=:]?\s*)?[1-9]|"exit_code"\s*:\s*[1-9])/i.test(String(p.output??''));
   // These are serialized harness envelopes, not statements made by a person.
   // Keep exact evidence, but never mine embedded background JSON for choices.
   const environment=role==='user'&&/^\s*<environment_context>[\s\S]*<\/environment_context>\s*$/.test(body);
   let preparedEnvelope=false;
   if(role==='user'&&body.startsWith('完整工作说明（背景为参考，目标与约束如下）：\n')){
    try{const packet=JSON.parse(body.slice(body.indexOf('\n')+1));preparedEnvelope=packet.protocolVersion==='synplex.workspace/1.0.0'&&typeof packet.contentHash==='string'&&typeof packet.goal==='string';}catch{}
   }
   const commentary=role==='assistant'&&p.phase==='commentary';
   candidateEligible.set(block.id,!duplicate&&!environment&&!preparedEnvelope&&!commentary&&(['user','assistant'].includes(role)||toolFailure));
   recent.set(key,{kind:value.type,seq,at});
   records.push({seq,sessionId,eventId:'snapshot:'+sourceHash+':'+seq,occurredAt:stamp(value.timestamp),payloadHash:sha256(line),blockIds:[block.id]});
  }catch(error){gap(end,['event_line_too_large','unsupported_event_shape','session_identity_conflict','unsupported_message_content','unsupported_event_type','session_identity_missing'].includes(error.message)?error.message:'invalid_json_or_utf8');}
  start=end;
 }
 const totalBytes=bytes.length,coveredBytes=totalBytes-gaps.reduce((n,g)=>n+g.rawEndByte-g.rawStartByte,0);
 return {parserVersion:CODEX_SESSION_PARSER,blocks,roles,candidateEligible,records,normalizedTextHash:payloadHash(blocks.map(b=>b.text)),coverage:{status:gaps.length?'partial':'complete',coveredBytes,totalBytes,gaps}};
}
