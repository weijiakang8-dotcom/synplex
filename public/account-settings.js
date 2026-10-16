import {nameField,accountEscape} from './account-forms.js';
export function bindAccountSettings({app,dialog,call,onChanged}){
 if(!dialog)return;
 app.addEventListener('click',async event=>{
  const button=event.target.closest('[data-account-settings]');if(!button)return;
  button.disabled=true;
  const bootstrap=await fetch('/api/v1/ui_bootstrap',{credentials:'same-origin'}).then(r=>{if(!r.ok)throw Error('请重新登录后再试。');return r.json();}).catch(()=>null);button.disabled=false;
  const account=bootstrap?.authentication?.account;if(!account){button.textContent='暂时无法打开，请刷新后重试';return;}
  dialog.innerHTML=`<div class="dialog-heading"><h2>账号设置</h2><button type="button" data-account-close aria-label="关闭">×</button></div><p>邮箱：${accountEscape(account.email)}</p><form class="account-screen" data-account-name>${nameField(account.username)}<p role="alert" aria-live="polite"></p><button type="submit" class="primary">保存登录名</button></form><p class="subtle">保存后可用新登录名或邮箱登录，已有资料不变。</p><a href="/app?account=reset">用邮箱重置密码</a>`;
  dialog.querySelector('[data-account-close]').onclick=()=>dialog.close();dialog.showModal();
  dialog.querySelector('form').onsubmit=async event=>{
   event.preventDefault();const form=event.currentTarget,submit=form.querySelector('[type=submit]'),message=form.querySelector('[role=alert]');submit.disabled=true;message.textContent='正在保存…';
   try{const value=await call('set-name',{username:form.elements.username.value});onChanged(value.account);message.textContent='登录名已保存，可用它或邮箱登录。';}
   catch(error){message.textContent=error.message;}finally{submit.disabled=false;}
  };
 });
}
