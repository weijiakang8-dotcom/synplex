import {knownModelMessage} from './model-feedback.js';
// Display wording only. Never write these translations back to source data,
// task packets, executor prompts, file names, or protocol identifiers.
const toolWords = Object.freeze({
  get_project_state: '查看项目进展', find_evidence: '查找原文',
  prepare_task: '准备任务', record_result: '保存成果',
  propose_lesson: '保存待确认的经验', get_operation: '查看处理进度'
});
const words = [
  ['原件', '原文件'], ['合成样例', '测试样例'], ['隔离的测试检查资料', '单独用于测试的资料'], ['约束', '要求'], ['验收样例', '测试样例'], ['核验', '检查'], ['成功自述', '成功说明'], ['自述', '自己的说明'],
  ['完整工作说明', '完整任务说明'], ['工作说明', '任务说明'], ['这次工作', '这次任务'],
  ['查询原工作', '查看原任务'], ['已保存的工作', '已保存的任务'],
  ['当前确认选择', '已确认的决定'], ['已确认选择', '已确认的决定'], ['确认选择', '已确认的决定'], ['合成验收', '测试检查'], ['文件核验', '文件检查'], ['模型自述', 'AI 自己的说明'],
  ['当前宿主', '当前使用的工具'], ['宿主', '使用的工具'], ['执行器', '执行工具'],
  ['原执行终态', '原任务的结束状态'], ['执行终态', '任务结束状态'], ['终态', '结束状态'],
  ['业务验收', '检查成果是否符合要求'], ['验收要求', '交付要求'], ['验收', '检查'],
  ['操作回执', '处理记录'], ['成果回执', '成果记录'], ['执行回执', '任务记录'],
  ['候选回执', '待确认的记录'], ['回执', '处理记录'],
  ['内容指纹', '内容校验结果'], ['原文指纹', '原文校验结果'], ['指纹', '内容校验结果'],
  ['请求标识', '提交编号'], ['操作标识', '处理编号'], ['原请求', '原提交'],
  ['凭据入口', '安全连接设置'], ['凭据', '连接信息'], ['密钥', '连接密码'],
  ['背景预算', '参考资料容量'], ['预算选取', '可用容量选取'],
  ['覆盖缺口', '未读取的部分'], ['覆盖范围', '已读取的范围'],
  ['资料解析', '读取资料'], ['解析器', '资料读取工具'], ['解析', '读取'],
  ['提取', '整理出'], ['待核对线索', '待确认的信息'], ['候选', '待确认的内容'],
  ['工作流', '任务流程'], ['预设', '默认'], ['隔离', '独立'], ['平台执行', '在这里执行'], ['外部委托', '交给其他工具执行'],
  ['冻结接口', '规定的提交格式'], ['字段', '填写项'],
  ['写回', '保存结果'], ['回流', '保存到项目'], ['租期', '运行有效期'],
];
export function systemText(value) {
  let text = String(value ?? '');
  for (const [from, to] of [...words].sort((a, b) => b[0].length - a[0].length)) text = text.replaceAll(from, to);
  return text;
}

export function fileLabel(value) {
  const name = String(value ?? '');
  const base = name.replace(/\.[a-z\d]+$/i, '');
  const kind = ({pdf:'阅读文档',md:'文字文档',txt:'文字文件',csv:'表格',xlsx:'表格',docx:'文档',pptx:'演示文稿'})[name.split('.').at(-1).toLowerCase()] || '成果文件';
  const phrases = {'cannot-book':'无法预订的说明','plugin-check':'扩展检查','next-actions':'下一步行动'};
  for (const [from, to] of Object.entries(phrases)) {
    if (base === from || base === from + '-revised') return to + (base.endsWith('-revised') ? '（修订版）' : '') + ' · ' + kind;
  }
  return readableText(base, '成果') + ' · ' + kind;
}

// This is a derived, labelled preview. Exact original text remains available
// in the existing full-text/details/download surfaces.
export function readableText(value, fallback = '内容包含详细操作步骤，请展开查看原文。') {
  let text = String(value ?? '').trim();
  text = text.replace(/读取已安装\s*Synplex\s*(?:插件\s*)?Skill\s*后[，,]?\s*(?:用\s*)?/giu, '了解项目背景后，')
    .replace(/Synplex\s*(?:插件\s*)?Skill/giu, '项目使用说明');
  for (const [from, to] of Object.entries(toolWords)) text = text.replaceAll(from, to);
  text = text.replace(/\bSQLite\b/gi, '本地资料库').replace(/\bPDF\b/g, '阅读文档（PDF）').replace(/\bMarkdown\b/gi, '可编辑的文字文件')
    .replace(/\bhost_assist\b/g, '在当前工具中继续')
    .replace(/\bcurrent_host\b/g, '当前使用的工具')
    .replace(/\bplatform_owned\b/g, '在这里执行')
    .replace(/\bdelegated\b/g, '交给其他工具执行')
    .replace(/\b(?:inputTokens|outputTokens|cachedInputTokens)\b/g, '模型用量')
    .replace(/\bcostUsd\b/g, '美元费用')
    .replace(/\b(?:requestId|operationId|eventId|attemptId|threadId|turnId)\b/g, '记录编号')
    .replace(/\bacceptanceCriteria\b/g, '交付要求')
    .replace(/\bconstraints\b/g, '任务要求')
    .replace(/\bgoal\b/g, '任务目标')
    .replace(/\b(?:contentHash|sha256)\b/gi, '内容校验结果')
    .replace(/\b(?:RPC|MCP|API)\b/g, '工具连接')
    .replace(/\bJSONL\b|\bNDJSON\b/g, '会话记录文件')
    .replace(/\bJSON\b/g, '数据文件')
    .replace(/\bSkill\b/gi, '使用说明')
    .replace(/\bAgent\b/gi, '执行工具')
    .replace(/\btoken(?:s)?\b/gi, '模型用量');
  text = systemText(text).replace(/可编辑的文字文件\s*文件/g, '可编辑的文字文档');
  // Never expose an unrecognised command/variable/path as a business summary,
  // or invent what the command did. The user can inspect the exact original.
  if (/\b(?:UTF-?8|SHA(?:-?256)?|confirmed|pending|rejected|superseded|retracted|active)\b|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}|\b[a-f\d]{8,}\b|\b(?:shasum|wc)\s+-|`|\b[a-zA-Z]\w*_\w+\b|```|(?:^|\s)(?:npm|node|python3?|curl|dsh|codex)\s+(?:run|plugin|--|\S+\.(?:mjs|py))|\/Users\/|\/api\/|\b[A-Z][A-Z_]{2,}\s*=|\b(?:function|const|let|import)\s+[a-zA-Z{]|\b[A-Za-z][\w.]*\([^)]*\)|^[\[{][\s\S]*[\]}]$/.test(text)) return fallback;
  if (!/[\p{Script=Han}]/u.test(text) && /[a-zA-Z]/.test(text)) return fallback;
  return text;
}

const errors = Object.freeze({
  validation_failed: '填写内容不完整、格式不正确或太长。请检查后再提交。',
  scope_denied: '没有访问权限，或内容不属于当前项目。请检查账号和所选项目。',
  conflict: '提交结果或资料内容需要核对。请先查看已有记录，避免重复提交。',
  stale_context: '项目进展或访问权限已更新。请刷新后重新准备任务。',
  budget_exceeded: '参考资料太多，无法全部带入任务。请少选一些资料，或提高参考资料容量。',
  capability_unavailable: '所需工具尚未连接或暂时不可用。已有内容仍保留，请检查工具连接。',
  unsupported_format: '暂时无法读取这种文件。请另存为支持的文本文件后上传。',
  partial_parse: '只读取了部分内容。请核对未读取的部分，必要时补充文字资料。',
  writeback_pending: '任务已结束，但结果尚未保存完整。请只补存结果，不要重新执行任务。'
});
export function errorText(error) {
  if(knownModelMessage(error?.message))return error.message;
  const reading='当前正在读取多份成果，请稍后再打开。',readingHelp=reading+'原文件和任务仍保留，无需重新执行。';
  if(error?.code==='capability_unavailable'&&[reading,readingHelp].includes(error.message))return readingHelp;
  if (errors[error?.code]) return errors[error.code];
  const raw = typeof error === 'string' ? error : [error?.message, error?.nextAction].filter(Boolean).join(' ');
  if (/fetch|network|load failed|timeout|timed out|abort/i.test(raw))
    return '连接中断或等待时间过长。请刷新查看已有进度，不要重复提交。';
  if (/SyntaxError|TypeError|ReferenceError|JSON|UTF-8|Content-Type|metadata|endpoint|scope|tokenFile|connectionFile|requestId|ECONN|ENOENT|EPIPE|sqlite|Traceback|stack|at \w+\s*\(/i.test(raw))
    return '返回内容暂时无法读取。请刷新查看已有进度；仍有问题时联系维护人员，不要重复提交。';
  return readableText(raw, '暂时无法完成这一步。请先查看已有进度，避免重复提交。') || '暂时无法完成这一步，请稍后查看进度。';
}

export function backgroundNote(value) {
  const text = String(value ?? '');
  if (/^历史线索 /.test(text)) return '这条旧记录已不再采用，仍保留供你回看，不作为当前结论。';
  if (/冲突/.test(text)) return '部分资料内容不同，请先到“待核对”页选择如何处理。';
  return readableText(text.replace(/增加预算/g, '提高参考资料容量').replace(/按预算选取/g, '按可用容量选取'));
}
