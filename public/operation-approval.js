const names={send_email:'发送邮件',create_agent:'保存智能体',execute:'执行外部操作'};
const fields={to:'收件人',recipient:'收件人',recipients:'收件人',subject:'主题',body:'正文',content:'内容',name:'名称',description:'说明'};
export function approvalDetails(prompt,esc){
 if(!prompt.approval)return '';
 return `<section aria-label="待确认的操作"><h4>本次操作</h4>${prompt.approval.operations.map((operation,index)=>`<article class="record"><h4>${index+1}. ${esc(names[operation.tool]||'外部操作')}</h4>${Object.entries(operation.params).map(([key,value])=>`<p class="excerpt"><strong>${esc(fields[key]||'操作内容')}：</strong>${esc(typeof value==='string'?value:JSON.stringify(value))}</p>`).join('')}<details><summary>原始操作信息</summary><pre>${esc(JSON.stringify(operation,null,2))}</pre></details></article>`).join('')}</section>`;
}
export const questionAction=prompt=>prompt.approval?'提交选择':'回答并继续';
export const questionHelp=prompt=>prompt.approval?'不会默认同意。内容改变后需重新确认；拒绝不会删除已有成果。':'回答后继续原任务，不会重新开始。请勿填写密码。';
export const waitingLabel=questions=>questions.some(q=>q.prompt?.approval)?'等待确认':'等待回答';
