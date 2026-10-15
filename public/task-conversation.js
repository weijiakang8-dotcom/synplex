export const currentQuestion=work=>work.conversation?.currentQuestion??work.packet.goal;
export const originalGoal=work=>work.conversation?.originalGoal??work.packet.goal;
export function followupForm(resultId,enabled,esc){
 if(!enabled)return '';
 return `<details><summary>继续提问</summary><p class="subtle">带上之前的问答和文件，沿用原任务的工具设置。追问不会替换原成果；准备后由你决定是否开始。</p><form class="result-followup-form" data-result="${esc(resultId)}"><label>想继续问什么<textarea name="question" required maxlength="4000" rows="3" placeholder="还有哪里想了解？"></textarea></label><button type="submit" data-ai-action="prepare_task_followup">准备追问</button></form></details>`;
}
export function conversationCard(work,esc){
 const conversation=work.conversation;if(!conversation)return '';
 return `<details class="fold" data-ai-role="task_conversation"><summary>之前的问答 · ${conversation.turns.length}</summary><p class="notice">之前的回答只作参考，不会自动成为已确认事实。每轮单独记录费用，追问不替换原成果。</p>${conversation.turns.map((turn,i)=>`<article class="record" data-ai-context="turn:${esc(turn.runId)}"><h3>第 ${i+1} 轮</h3><h4>你的问题</h4><p class="excerpt">${esc(turn.question)}</p><h4>工具回答</h4><p class="excerpt">${esc(turn.answer)}</p><button data-action="step-result" data-id="${esc(turn.resultId)}">查看这轮成果</button></article>`).join('')}</details>`;
}
