import { readableText, systemText } from './user-copy.js';
export { systemText };
// Presentation only: never change saved goals, executor events, or task status.
export const TASK_STATUS = Object.freeze({
  queued: '排队中', running: '正在执行', unknown: '执行待核对',
  succeeded: '执行结束', failed: '未完成', cancelled: '已停止', needs_input: '需要补充'
});
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
export function taskTitle(goal, maxCharacters = 36) {
  const technicalGoal = String(goal ?? '');
  const usesProjectTool = /^\s*读取已安装\s*Synplex\s*(?:插件\s*)?Skill\s*后[，,]?\s*用\s+get_project_state/iu.test(technicalGoal);
  const intent = usesProjectTool ? (/find_evidence/.test(technicalGoal) ? '查看项目进展和原文' : '查看项目进展') : null;
  const text = (intent || readableText(goal, '查看完整任务说明')).trim().replace(/\s+/gu, ' ');
  const characters = Array.from(text);
  return characters.length > maxCharacters ? characters.slice(0, maxCharacters).join('') + '…' : text || '任务';
}
export function activityText(event, status) {
  const label = readableText(event.label, '正在处理任务，详细步骤已保留。');
  if (!TERMINAL.has(status) && status !== 'unknown') return label;
  // An event says that a step started; it does not prove that the step finished.
  // Remove the live tense without inventing successful completion of a failed step.
  return '执行记录：' + label.replace(/^正在/u, '');
}
export function executionActivity(events,status,esc,date,expanded=false){
 if(!events?.length)return '';
 const recent=events.slice(-3);
 return `<div class="execution-steps" aria-live="polite">${recent.map((event,index)=>`<p>${esc(activityText(event,index===recent.length-1?status:'unknown'))}</p>`).join('')}</div><details data-ai-role="execution_activity" ${expanded?'open':''}><summary data-ai-action="view_execution_steps" data-tip="查看最近同步的执行步骤，不会重新执行任务">步骤记录</summary><p class="subtle">最多显示最近同步的100条。步骤结束后，成果仍需检查。</p><ol>${events.map(event=>`<li>记录于 <time datetime="${esc(event.at)}">${esc(date(event.at))}</time> · ${esc(activityText(event,'unknown'))}</li>`).join('')}</ol></details>`;
}
