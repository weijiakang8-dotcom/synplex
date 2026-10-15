import {ProtocolError} from '../contracts/validate.mjs';

// Fixed business labels only. Executor descriptions, tool arguments, model
// output and private reasoning must never become progress labels.
export const ACTIVITY_LABELS=Object.freeze({
 connecting:'正在连接执行工具',working:'正在处理这次工作',tool:'正在执行一个步骤',
 collecting:'正在保存成果',verifying:'正在核对成果文件',waiting:'需要补充信息或权限',
 environment:'正在准备执行环境',environment_ready:'执行环境已就绪',
 planning:'正在整理执行步骤',planned:'执行步骤已整理',proposing:'正在整理待确认的操作',proposed:'待确认的操作已整理',
 reading:'正在读取资料',calculating:'正在计算表格',exporting:'正在生成文件',
 checking_code:'正在检查代码',testing_code:'正在运行代码样例',searching:'正在查找资料',
 tool_done:'这一步已结束，结果仍需检查',tool_failed:'这一步未完成，已有内容仍保留',
 tool_unknown:'这一步的结果仍需核对',step_done:'执行步骤已结束，成果仍需检查',
 checking:'正在检查任务结果',execution_done:'执行工具已结束，成果仍需检查',
 execution_failed:'执行工具未完成任务，已有内容仍保留',
 progress_unavailable:'具体进度暂时无法读取，可继续查看原任务结果',
 progress_partial:'步骤较多，部分进度尚未同步，已有成果仍可查看'
});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
export function activitySource(value){
 if(value===undefined)return null;
 if(!value||Object.keys(value).sort().join(',')!=='eventId,sequence,taskId'||!uuid(value.taskId)||!uuid(value.eventId)||!Number.isSafeInteger(value.sequence)||value.sequence<1)
  throw new ProtocolError('validation_failed','执行步骤的来源不完整。','只读取原任务已有的进度，不重新执行。');
 return {taskId:value.taskId,eventId:value.eventId,sequence:value.sequence};
}
