import {isFixtureSource} from './source-relevance.mjs';
export const SELECTION_VERSION='synplex.project-events/12';
const event=/决定|决策|改为|转向|改用|放弃|取舍|纠正|误解|不再|原因|根因|卡点|教训|可复用|下次|验收|实测|复盘|失败|报错|阻塞|约束|必须|不得|不能|为什么|因此|解决|恢复|\b(decid|fail|constraint|lesson|because|instead|verified)/i;
const value=/决定|改为|转向|改用|放弃|取舍|纠正|误解|根因|卡点|失败|报错|阻塞|教训|可复用|下次|实测|复盘|解决|恢复|因为|由于|导致|因此|结果|尚未|未完成|禁止|必须|不得|不能|不等于|\b(because|instead|lesson|constraint|failed|verified)/i;
const foreign=/(?:^|\/)(?:生活|计算机知识基础|Skill|阅读|收藏|外部资料|历史学习日记|课程)(?:\/|$)|来源待核验|他人经历/;
const noise=/^\s*(?:```|~~~|\$\$|\{\s*"|<environment_context>|<INSTRUCTIONS>|#{1,6}\s+[^\n]+\s*$)|^(?:你好|hello|收到|继续|好的|谢谢|已完成|开始执行)[。！!\s]*$/i;
const normalize=text=>text.normalize('NFKC').replace(/\s+/g,' ').trim();
const eventSource=/实施|验收|复盘|讨论|阻碍|方案|决策|验证|取舍|修复|补齐|效益|实验|交付|协作入口|源码发布|真实演示|账号注册|排查/;
const actual=/修复|补齐|解除|未验|未完成|尚未|实际|实测|真实|未知|无法|缺口|缺少|失败|根因|卡点|改为|转向|取舍|提出|要求|不等于|不能|不得|必须|不把|区分|优先|限定|\d+\s*\/\s*\d+|参考费|费用差额|用时/;
const historicalFix=/修复方法|产生原因|已证明根因|报错现象|现象(?:\*+)?[：:]|解决[：:]|原来.{0,48}(?:太虚|误名|误解|错误)/;
function eventChoice(claim,body){
 const type=/可复用|下次|经验|教训|lesson/i.test(body)?'lesson':/转向|改为|决定|纠正|取舍|instead|decid/i.test(body)?'decision':/失败|报错|阻塞|卡点|failed|error/i.test(body)?'failure':'unknown';
 const outcome=/实测|验证|结果|通过|未通过|未完成|尚未|未知|失败|\d+\s*\/\s*\d+/.test(body)?'原文包含结果或明确未完成状态':'原文尚无独立验证结果';
 return {selected:true,reason:'含可定位的项目事件；'+outcome,type,protected:false,group:normalize(body)};
}
function excludedSource(sourcePath,primaryTopic){
 if(isFixtureSource(sourcePath))return '测试输入或样例产物不是项目实际经历；原件仍可明确选用';
 if(/原文件夹待核对|来源待核验/.test(sourcePath))return '历史材料的原始归属尚未核实；仍保留并可查找';
 if(foreign.test(sourcePath))return '外部、通用知识或其他生活主题；原文仍可查找';
 const topic=sourcePath.match(/(?:^|\/)项目\/([^/]+)/)?.[1];
 if(primaryTopic&&topic&&topic!==primaryTopic)return '属于另一项目；原件保留，可明确选择为参考资料';
 if(/成长与职业|展示材料|演讲|作品集|拿手菜|提交稿|\.pptx?$|市场产品|学术可靠性/i.test(sourcePath))return '展示、学习或外部对标材料，未当作项目实际经历';
 return null;
}
const contribution=(body,path)=>/(?:本人|用户|AI|人机)贡献[：:]/.test(body)&&/项目\//.test(path);
const empiricalBoundary=body=>/现有|本项目|本次|本轮|既有|旧.{0,8}实验|此前/.test(body)&&/次|组|变体|样本|对照|实测/.test(body)&&/不满足|不是|不可|不能|未测|尚未/.test(body);
const ownMeasurement=(body,path)=>/^项目\/AgentHub\/Synplex/.test(path)&&empiricalBoundary(body);
const authoredEvent=(body,path)=>contribution(body,path)||ownMeasurement(body,path);
const legacyEvidence=body=>/真实验证过|生产验证过|已完成真实演练|测试基线|已部署并健康|图表关键改动[：:]|修复为|实测定位|定位为/.test(body)||/\|\s*维度\s*\|\s*事实\s*\|/.test(body)&&/生产实测|恢复演练|CI/.test(body);
const projectMeasurement=body=>/历史|本次|本轮|本项目|现有/.test(body)&&/实验|合格|参考费|实付/.test(body)&&/\d/.test(body)&&/回滚|未达|下降|未知|没有|不能|不应/.test(body);
const recoveryEvidence=body=>/快照|备份/.test(body)&&/SHA256|指纹/.test(body)&&/不可覆盖|核对|保护/.test(body);
const localAudit=(body,path)=>/^项目\/AgentHub\/Synplex/.test(path)&&body.length>=60&&/本轮|本次|当前|融合版|这些失败|审计日期|已批准计划|建议本地安全发布/.test(body)&&/完成|失败|验收|验证|核对|不能|不把|未开展|门槛|依据|范围/.test(body);
const isNoise=body=>noise.test(body)||body.length<8||/^---\s*\n/.test(body);
function sourceEvent(body,sourcePath){
 if(/技术学习|早期架构与学习/.test(sourcePath)&&(historicalFix.test(body)||legacyEvidence(body)||/里程碑|理由与取舍|为什么不做|本轮按.*要求/.test(body)))return true;
 if(!eventSource.test(sourcePath)||body.length<60)return historicalFix.test(body);
 const audit=/(?:实际|真实|实测|检查|对照|核对|指纹|哈希|SHA|验收|回归|修复|接回|新增|修正)/i.test(body)&&/(?:通过|一致|匹配|失败|错误|未知|未验|未完成|没有|不等于|未装|不代表|尚待)/.test(body);
 const measurement=/(?:合格|参考费|参考美元|墙钟秒)/.test(body)&&/\d/.test(body);
 return audit||measurement||historicalFix.test(body)||actual.test(body);
}
function textEligibility(body,sourcePath){
 if(isNoise(body))return {selected:false,reason:'标题、环境说明、代码或过短片段'};
 if(/^(?:目前不需要|当前无需|下一步先|现在无需).*(?:本人|介入|操作)/.test(body)&&body.length<100)return {selected:false,reason:'交接进度没有新的项目事件；原文仍保留'};
 if(projectMeasurement(body)||recoveryEvidence(body))return {selected:true};
 if(authoredEvent(body,sourcePath)||localAudit(body,sourcePath))return {selected:true};
 const boundary=/(?:不要破坏|不开放|不替.*授权|不宣称|不能只测试|不会.*(?:改动|启动)|不创建任务|没有.*(?:上线|部署|验证)|不是.*验收)/.test(body);
 if(boundary&&/(?:登录|注册|对话|权限|模型|任务|执行|原件|成果|宿主|服务)/.test(body))return {selected:true};
 if(sourceEvent(body,sourcePath))return {selected:true};
 if(/(?:必须|不得|禁止|保持|保留).*(?:原件|原稿|历史|数据|权限|登录|旧资产)/.test(body))return {selected:true};
 return null;
}

// This gate selects reviewable events, not facts. Every rejected fragment stays
// in the original source and full-text index. Unknown outcomes remain unknown.
function explicitProjectEvidence(body,sourcePath,primaryTopic){
 if(primaryTopic!=='AgentHub'||/展示材料|\.pptx?$|Skill\//i.test(sourcePath))return false;
 if(/Synplex/.test(body)&&/\[\[项目\/AgentHub\//.test(body)&&/(?:真实|实测|验收)/.test(body))return true;
 if(!/^项目\/AgentHub\/Synplex/.test(sourcePath))return false;
 if(localAudit(body,sourcePath))return true;
 if(/\|\s*故障类别\s*\|/.test(body)&&/当前代码|既有证据|尚缺/.test(body))return true;
 const datedChange=/\d{4}-\d{2}-\d{2}/.test(body)&&/\b[a-f0-9]{7,40}\b/.test(body)&&/增加|修复|验证|核对|补|通过|改动/.test(body);
 return datedChange||empiricalBoundary(body);
}
const isHumanClaim=claim=>claim.evidenceKind==='user_statement';
function protectedClaim(claim){return isHumanClaim(claim)||!(claim.condition||'').startsWith('仅为原文规则候选');}
function sourceExclusion(body,sourcePath,primaryTopic){
 const reason=excludedSource(sourcePath,primaryTopic);
 return reason&&(isFixtureSource(sourcePath)||!explicitProjectEvidence(body,sourcePath,primaryTopic))?reason:null;
}
export function selectEvent({claim,sourcePath='',context='',primaryTopic=null}){
 const body=claim.body.trim(),protectedRecord=protectedClaim(claim);
 if(isHumanClaim(claim))return {selected:true,reason:'保留人工编写或单独提炼的记录',protected:true,group:claim.id};
 if(!claim.evidence?.length)return {selected:false,reason:'缺少可定位原文'};
 const sourceReason=sourceExclusion(body,sourcePath,primaryTopic);if(sourceReason)return {selected:false,reason:sourceReason};
 if(protectedRecord)return {selected:true,reason:'保留单独提炼且来源属于本项目的记录',protected:true,group:claim.id};
 if(primaryTopic&&!sourcePath.includes('/')&&!/(?:Synplex|AgentHub)/i.test(sourcePath))return {selected:false,reason:'仓库规则或一般说明不是当前项目经历；原文仍保留'};
 const eligibility=textEligibility(body,sourcePath);if(eligibility)return eligibility.selected?eventChoice(claim,body):eligibility;
 if(!event.test(body))return {selected:false,reason:'没有项目决定、约束、验证、失败或转折线索'};
 const localContext=(context+'\n'+body).slice(-12000);
 if(!value.test(body)||!value.test(localContext))return {selected:false,reason:'只有零散关键词，尚无可复用的事件信息'};
 const constraint=/^\s*(?:[-*]\s*)?(?:约束|限制|要求|验收)\s*[：:]/.test(body)&&/必须|不得|不能|禁止|保留/.test(body);
 const episode=/决定|改为|转向|改用|放弃|取舍|纠正|误解|根因|卡点|教训|可复用|下次|实测|复盘|失败|报错|不等于|\b(lesson|failed|because|instead|verified)/i.test(body);
 if(!constraint&&!episode)return {selected:false,reason:'一般步骤或说明，尚未构成重要项目事件'};
 return eventChoice(claim,body);
}
