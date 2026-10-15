import {activitySource} from '../../packages/execution/activity.mjs';

const tools=Object.freeze({read_task_file:'reading',summarize_table:'calculating',export_document:'exporting',check_task_code:'checking_code',test_task_python:'testing_code',search_web:'searching'});
const phases=Object.freeze({environment:['environment','environment_ready'],plan:['planning','planned'],proposal:['proposing','proposed'],verify:['checking','step_done']});
const own=(values,key)=>Object.hasOwn(values,key)?values[key]:null;
function stageFor(event){
 if(event.event==='tool_call')return own(tools,event.tool_name)??'tool';
 if(event.event==='tool_result')return own({success:'tool_done',duplicate:'tool_done',failed:'tool_failed',error:'tool_failed',unknown:'tool_unknown'},event.status);
 if(event.event==='activity'){const phase=own(phases,event.phase),index=own({started:0,completed:1},event.status);return phase&&index!==null?phase[index]:null;}
 if(event.event==='step')return own({started:event.node==='plan'?'planning':'working',completed:'step_done'},event.status);
 return own({execution_completed:'execution_done',execution_failed:'execution_failed',clarification_required:'waiting',approval_required:'waiting'},event.event);
}
function readPage(page,record){
 const after=record.activityCursor??0;
 if(page?.execution?.id!==record.taskId||page.execution.workflow_id!==record.workflowId||!Array.isArray(page.events)||page.events.length>200||typeof page.has_more!=='boolean'||!Number.isSafeInteger(page.cursor)||page.cursor<after)throw Error('Invalid progress page');
 let last=after;
 const events=page.events.map(event=>{
  const source=activitySource({taskId:event.execution_id,eventId:event.event_id,sequence:event.sequence});
  if(source.taskId!==record.taskId||source.sequence<=last)throw Error('Foreign or unordered progress');
  last=source.sequence;
  const stage=stageFor(event);return stage?{stage,source}:null;
 }).filter(Boolean);
 if(page.cursor!==last||page.has_more&&page.events.length!==200)throw Error('Invalid progress cursor');
 return {events,cursor:last,more:page.has_more};
}
// Optional read-only feed: losing it never submits/cancels work or hides a
// valid delivery. Cursor advances only after the workspace accepted each event.
export function agentHubActivity({request,save,now=Date.now,retryMs=5000}){
 let retryAt=0,unavailable=false,partial=false;
 function unavailableNotice(input){
  if(unavailable||input.signal?.aborted)return;
  unavailable=true;
  try{input.report?.({stage:'progress_unavailable'});}catch{ /* Results keep their own permission and persistence checks. */ }
 }
 return async function observe(input,record,workflowId){
  if(now()<retryAt||input.signal?.aborted)return;
  const before=record.activityCursor;
  try{
   const page=readPage(await request('/api/executions/'+record.taskId+'/activity?after='+(record.activityCursor??0),{signal:input.signal,timeoutMs:2000}),{...record,workflowId});
   for(const event of page.events)input.report?.(event);
   if(page.more&&!partial){input.report?.({stage:'progress_partial'});partial=true;}
   record.activityCursor=page.cursor;save(input.operationId,record);
   retryAt=0;unavailable=false;partial=page.more;
  }
  catch{
   record.activityCursor=before;retryAt=now()+retryMs;unavailableNotice(input);
  }
 };
}
