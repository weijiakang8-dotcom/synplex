export const accountEscape=x=>String(x??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function nameField(value=''){
 return `<label>登录名<input name="username" type="text" autocomplete="username" minlength="3" maxlength="32" pattern="[a-zA-Z][a-zA-Z0-9_-]{2,31}" required placeholder="例如：xiaoming" value="${accountEscape(value)}"><small>3到32位，以字母开头，可用字母、数字、下划线或短横线；不区分大小写。</small></label>`;
}
function passwordFields(isNew){
 return `<label>${isNew?'设置新密码':'密码'}<span class="account-password"><input name="password" type="password" autocomplete="${isNew?'new-password':'current-password'}" minlength="8" maxlength="1024" required ${isNew?'placeholder="至少8位"':''}><button type="button" data-auth-show aria-label="显示密码" title="显示密码">显示</button></span></label>${isNew?'<label>确认密码<input name="confirm" type="password" autocomplete="new-password" minlength="8" maxlength="1024" required></label>':''}`;
}
function codeFields(){return '<label>邮箱验证码<span class="account-code"><input name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="6位数字" required><button type="button" data-auth-send>获取验证码</button></span></label>';}
const details={login:['登录 Synplex','使用登录名或邮箱和密码，继续你的项目。','登录'],register:['注册 Synplex','创建账号，项目与资料独立保存。','注册并进入'],reset:['重置密码','通过注册邮箱收取验证码，设置新密码。','保存新密码']};
function registrationExtra(status){
 return status.canClaimLocal?'<label class="account-claim"><input name="inheritLocal" type="checkbox">带入这台电脑的已有项目</label><p class="subtle">仅原工作台主人能选择，原资料和模型连接不会复制给其他账号。</p>':'';
}
export function accountForm(mode,email,status){
 const registration=mode==='register',login=mode==='login',[title,description,submit]=details[mode];
 const identity=login?`<label>登录名或邮箱<input name="email" type="text" autocomplete="username" maxlength="254" required placeholder="请输入登录名或注册邮箱" value="${accountEscape(email)}"></label>`:`${registration?nameField():''}<label>邮箱<input name="email" type="email" autocomplete="email" maxlength="254" required placeholder="接收验证码的注册邮箱" value="${accountEscape(email.includes('@')?email:'')}"></label>`;
 const mailUnavailable=!login&&!status.mailReady;
 return `<main class="connection-screen account-screen" data-ai-context="account"><a class="account-brand" href="/"><img src="/brand/logo-mark.png" alt="Synplex"></a><h1>${title}</h1><p>${description}</p><form data-auth-form>${identity}${passwordFields(!login)}${!login?codeFields():''}${registration?registrationExtra(status):''}${mailUnavailable?'<p class="notice">网站暂未设置发件邮箱，暂时不能获取验证码。已有账号可直接登录。</p>':''}${mode==='reset'?'<p class="subtle">保存后，所有已登录的网页都需要用新密码重新登录；项目与资料保留。</p>':''}<p role="alert" aria-live="polite" data-auth-message></p><button class="primary" type="submit" ${mailUnavailable?'disabled':''}>${submit}</button></form><button type="button" class="text-button" data-auth-switch>${login?'没有账号？注册':'返回登录'}</button>${login?'<button type="button" class="text-button" data-auth-forgot>忘记密码？</button>':''}<a href="/">返回首页</a></main>`;
}
