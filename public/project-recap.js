import {curationControls} from './source-curation.js';
export const RECAP_QUESTIONS={
 evidence:'本项目有哪些完整核心链路的真实测试数据？请区分首次与修复后完成率、失败、恢复、改稿、跨工具接续，给出样本数、条件和出处。没有测量的直说，不要拿小功能测试条数替代。',
 lessons:'本项目有哪些可以用于下次项目的经验？请按问题、尝试、为什么转向、结果、可复用步骤和适用条件回答，并给出出处。保留失败与未完成项，不把外部收藏算成本人的经历。',
 turns:'本项目的人与AI讨论中，哪些意见实际改变了方案？请具体列出谁提出什么、原方案有什么问题、改成什么、如何核对，并引用原始记录。'
};
export function bindProjectRecap(app,onQuestion){
 app.addEventListener('click',event=>{const button=event.target.closest('[data-recap-question]');if(!button)return;event.stopImmediatePropagation();onQuestion(RECAP_QUESTIONS[button.dataset.recapQuestion]);});
}
export function projectRecap(history,state,esc){
 const proposals=history.lessonCandidates?.total??state.pending.filter(c=>c.type==='lesson').length,selection=history.candidateSelection;
 return `<section class="panel" data-ai-context="project-recap">
 <div class="section-heading"><h2>项目复盘</h2><button type="button" data-nav="results">查看成果 ↗</button></div>
 <p>看看哪些做法经过了检验、哪些经验能带走、哪些讨论改变了方向。</p>
 <div class="button-row">${[['evidence','实测结果'],['lessons','可用经验'],['turns','关键转折']].map(([id,name])=>`<button type="button" data-recap-question="${id}" data-ai-action="prepare_project_recap" data-ai-id="recap:${id}" data-tip="带着项目资料准备问题，查看后再发送">${name}</button>`).join('')}</div>
 ${curationControls(history,esc)}
 ${proposals?`<p class="subtle">本项目有 ${proposals} 条经验等待核对。<button type="button" data-nav="results">查看经验</button></p>`:''}
 ${selection?`<details><summary>资料如何筛选</summary><p>从 ${esc(selection.unreviewedFragments)} 段未核对原文中选出 ${esc(selection.selectedEvents)} 条项目线索，其中 ${esc(selection.curatedEvents??selection.selectedEvents)} 条已整理为待核对记录，${esc(selection.rawSignals??0)} 条仍待整理；其余原文也保留在资料中，可以搜索。规则排除无关片段，模型分批整理完整事件；重复叙述合并展示，关键约束、失败和否定结果须保留。入选不等于已经确认。</p></details>`:''}</section>`;
}

export const isSourceSignal=claim=>(claim.condition||'').startsWith('仅为原文规则候选');
export const reviewCount=(history,state)=>history.candidateSelection?.curatedEvents??history.pendingTotal??state.pending.length;
export function reviewQueue(history,state,limit,card,empty,esc){
 const loaded=state.pending.slice(0,limit),ready=loaded.filter(c=>!isSourceSignal(c)),raw=loaded.filter(isSourceSignal),signals=history.candidateSelection?.rawSignals??raw.length;
 return curationControls(history,esc)+'<div class="grid">'+(ready.length?ready.map(card).join(''):empty('暂时没有整理好的记录',signals?'可以先整理重点，也可以展开下方初筛线索，自己核对。':'加入项目资料后，重要记录会出现在这里。'))+'</div>'+(signals?'<details data-ai-role="source_signals"><summary>初筛线索 · '+esc(signals)+' 条尚未整理</summary><p class="subtle">这些是规则找到的原文片段，尚未合并成完整事件，不计入上方待核对数量。原文仍可搜索，也可以在这里逐条核对。</p><div class="grid">'+raw.map(card).join('')+'</div></details>':'');
}
