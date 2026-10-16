import {accountEscape as escape,accountForm} from './account-forms.js';
import {bindAccountSettings} from './account-settings.js';
import {ACCOUNT_PATHS,accountMode} from './account-navigation.js';
export function createAccountUI({app,onLegacy,dialog,onChanged=()=>{}}){
 let mode='login',email='',until=0,timer=null,status=null,busy=false;
 const channel=typeof BroadcastChannel==='function'?new BroadcastChannel('synplex-account-'+location.host):null;
 if(channel)channel.onmessage=()=>location.reload();
 async function call(action,body){
  const response=await fetch('/api/v1/auth/'+action,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  let value;try{value=await response.json();}catch{throw Error('暂时无法连接，请稍后再试。');}
  if(!response.ok)throw Error(value.message||'暂时无法完成，请稍后再试。');return value;
 }
 bindAccountSettings({app,dialog,call,onChanged});
 function message(text){const node=app.querySelector('[data-auth-message]');if(node)node.textContent=text;}
 function countdown(){
  const button=app.querySelector('[data-auth-send]');if(!button)return;
  const seconds=Math.max(0,Math.ceil((until-Date.now())/1000));button.disabled=busy||seconds>0||!status.mailReady;button.textContent=seconds?`${seconds}秒后重发`:mode==='reset'?'获取重置验证码':'获取注册验证码';
 }
 function render(){
  clearInterval(timer);app.innerHTML=accountForm(mode,email,status);
  document.title=(mode==='reset'?'找回密码':mode==='register'?'注册':'登录')+' · Synplex';
  app.querySelector('[data-auth-show]').onclick=e=>{const input=app.querySelector('[name=password]'),show=input.type==='password';input.type=show?'text':'password';e.currentTarget.textContent=show?'隐藏':'显示';e.currentTarget.setAttribute('aria-label',show?'隐藏密码':'显示密码');};
  const send=app.querySelector('[data-auth-send]');if(send)send.onclick=sendCode;
  app.querySelector('[data-auth-form]').onsubmit=submit;countdown();timer=setInterval(countdown,1000);
 }
 async function sendCode(){
  const input=app.querySelector('[name=email]');if(busy||!input.reportValidity())return;busy=true;countdown();message('正在发送验证码…');
  try{await call(mode==='reset'?'reset-code':'send-code',{email:input.value});until=Date.now()+60000;message(mode==='reset'?'如果该邮箱已注册，重置验证码会发送至邮箱，5分钟内有效。未注册请先创建账号；也请检查垃圾邮件。':'注册验证码已发送，5分钟内有效。请查看收件箱或垃圾邮件。');}
  catch(error){message(error.message);}finally{busy=false;countdown();}
 }
 function payload(data){
  const value={email:String(data.get('email')),password:String(data.get('password'))};
  if(mode!=='login')value.code=String(data.get('code'));
  if(mode==='register'){value.username=String(data.get('username'));value.inheritLocal=data.get('inheritLocal')==='on';}return value;
 }
 async function submit(event){
  event.preventDefault();if(busy)return;const form=event.currentTarget,data=new FormData(form);
  if(mode!=='login'&&data.get('password')!==data.get('confirm')){message('两次输入的密码不一致。');return;}
  busy=true;const button=form.querySelector('[type=submit]');button.disabled=true;message('正在提交…');
  try{
   await call(mode==='reset'?'reset-password':mode,payload(data));
   if(mode==='reset'){channel?.postMessage('changed');location.replace(ACCOUNT_PATHS.login+'?notice=password-reset');return;}
   channel?.postMessage('changed');location.replace('/app');
  }catch(error){message(error.message);button.disabled=false;}finally{busy=false;}
 }
 return {async show(){
  const response=await fetch('/api/v1/auth/status',{credentials:'same-origin'});if(response.status===404){onLegacy();return;}if(!response.ok)throw Error('暂时无法打开登录页面，请重新加载。');status=await response.json();if(!status.enabled){onLegacy();return;}
  mode=accountMode(location);const resetDone=mode==='login'&&new URLSearchParams(location.search).get('notice')==='password-reset';
  history.replaceState(null,'',ACCOUNT_PATHS[mode]);render();if(resetDone)message('密码已重置，请用新密码登录。');
 },async logout(authentication){
  if(authentication?.account)await call('logout',{});else{const response=await fetch('/api/v1/ui_logout',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error('暂时无法退出，请稍后重试。');}
  channel?.postMessage('changed');location.replace(ACCOUNT_PATHS.login);
 }};
}
export function accountControls(authentication){
 if(authentication?.account)return `<button type="button" class="text-button" data-account-settings data-tip="设置登录名或通过邮箱重置密码">账号设置</button><small>${escape(authentication.account.username||authentication.account.email)}</small>`;
 return authentication?.canClaimLocal?'<a class="text-button" href="/register">绑定邮箱</a>':'';
}
export const accountLogoutLabel=authentication=>authentication?.account?'退出登录':'退出连接';
