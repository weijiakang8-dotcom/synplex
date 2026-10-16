import {mkdirSync,lstatSync,openSync,fstatSync,closeSync,writeSync,renameSync,constants} from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {payloadHash} from '../../packages/contracts/validate.mjs';

// Never record headers, query strings, request/response bodies, error messages,
// source text, filesystem paths or the caller's raw correlation identifiers.
const routes=new Set(('ui_chat_create ui_chat_lookup ui_chat_list ui_chat_history ui_chat_events ui_chat_send ui_chat_stop ui_chat_review ui_models ui_save_model ui_change_model ui_discover_models ui_probe_model ui_bootstrap ui_pair ui_logout ui_history ui_launch ui_select_project ui_create_project ui_extension ui_verify_artifact import_source get_import_result authorize_review review_claim '+
 'get_project_state find_evidence prepare_task record_result propose_lesson get_operation ui_find_evidence ui_task_detail '+
 'ui_pending_page ui_materials_page ui_import_status ui_project_revision ui_obsidian_notes ui_source_preview_page ui_result_versions ui_adopt_task_result ui_claim_detail ui_compare_claims ui_source_history ui_task_plan ui_source_preview ui_source_brief ui_artifact_preview artifact_file source_file ui_note_preview ui_note_file ui_project_preview ui_project_file ui_expression_versions ui_expression_version ui_approve_expression ui_stop_expression ui_expression_link '+
 'ui_reconcile_usage ui_resolve_conflict ui_answer_question ui_reconnect_input authorize_execution execute_task execution_state reconcile_execution cancel_execution '+
 'ui_edit_claim ui_restore_claim ui_source_metadata ui_review_result ui_result_lesson ui_create_task_plan ui_prepare_step ui_prepare_followup ui_start_plan_step ui_task_routes ui_select_task_route').split(' '));
for(const name of ['ui_curate_start','ui_curate_state'])routes.add(name);
const codes=new Set(['validation_failed','scope_denied','conflict','stale_context','budget_exceeded','capability_unavailable','unsupported_format','partial_parse','writeback_pending']);
const hash=value=>value===undefined||value===null?null:payloadHash(value).slice(0,24);
const routeName=url=>{const name=String(url).split('?')[0].replace(/^\/api\/v1\//,'');return routes.has(name)?name:'other';};
export const diagnosticStatus=sink=>sink?.status()??{enabled:false,available:false};

export function beginRequestTrace(req,res,sink){
 const traceId=randomUUID(),start=performance.now();let completed=false,errorCode=null,owner=null,scope=null,request=null,operation=null,run=null,result=null;
 res.setHeader('X-Synplex-Trace-Id',traceId);
 function finish(ended){
  if(completed)return;completed=true;if(!String(req.url).startsWith('/api/'))return;
  const event={format:'synplex.request-diagnostic/1',traceId,recordedAt:new Date().toISOString(),route:routeName(req.url),method:['GET','POST'].includes(req.method)?req.method:'OTHER',
   status:ended?res.statusCode:null,outcome:ended?'response_finished':'connection_closed',errorCode,durationMs:Math.round((performance.now()-start)*1000)/1000,owner,scope,request,operation,run,result};
  try{sink?.write(event);}catch{/* Diagnostic failure cannot undo a committed business operation. */}
 }
 res.once('finish',()=>finish(true));res.once('close',()=>finish(false));
 return {
  traceId,
  actor(auth){owner=hash(auth.ownerId);},
  input(input){if(!input||typeof input!=='object')return;scope=hash(input.scope);request=hash(input.requestId);operation=hash(input.operationId);run=hash(input.runId);result=hash(input.resultId);},
  failure(error){errorCode=codes.has(error.code)?error.code:'internal_error';},
 };
}

export function createDiagnosticLog(dataDir,{maxBytes=1024*1024}={}){
 if(!Number.isSafeInteger(maxBytes)||maxBytes<1024||maxBytes>1024*1024)throw new TypeError('Invalid diagnostic retention');
 const dir=join(dataDir,'diagnostics'),file=join(dir,'requests.jsonl');let failed=false;
 // Do not follow an existing log directory or relax somebody else's permissions.
 try{
  mkdirSync(dir,{mode:0o700,recursive:true});const directory=lstatSync(dir);
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.mode&0o077||directory.uid!==process.getuid())throw new Error('Unsafe diagnostic directory');
 }catch{failed=true;process.stderr.write('工作台诊断目录暂时不可用；请维护人员检查，已有资料不受影响。\n');}
 function opened(){
  const fd=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600),stat=fstatSync(fd);
  if(!stat.isFile()||stat.mode&0o077||stat.uid!==process.getuid()||stat.nlink!==1){closeSync(fd);throw new Error('Unsafe diagnostic file');}
  return {fd,size:stat.size};
 }
 return {
  status:()=>({enabled:true,available:!failed,maximumBytes:maxBytes*2}),
  write(event){
   if(failed)return;
   let fd;
   try{
    const bytes=Buffer.from(JSON.stringify(event)+'\n');if(bytes.length>1024||bytes.length>maxBytes)throw new Error('Oversized diagnostic event');
    let openedFile=opened();fd=openedFile.fd;
    if(openedFile.size+bytes.length>maxBytes){closeSync(fd);fd=undefined;renameSync(file,file+'.1');openedFile=opened();fd=openedFile.fd;}
    if(writeSync(fd,bytes)!==bytes.length)throw new Error('Partial diagnostic write');
   }catch{failed=true;process.stderr.write('工作台诊断记录暂时无法保存；已保存的任务和资料不受影响。\n');}
   finally{if(fd!==undefined)closeSync(fd);}
  },
 };
}
