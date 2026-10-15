export function connectionScreen(){
 return `<div class="connection-screen"><img src="/brand/logo-mark.png" alt="Synplex"><h1>连接你的工作台</h1><p>首次使用、登录过期或服务重启后，请重新打开本机“打开Synplex”入口。正常刷新无需重新连接。</p><form id="connection-form" method="post" action="/api/v1/ui_pair"><label>连接码<input type="password" name="pair" autocomplete="off" required aria-label="连接码"></label><button type="submit" class="primary">连接工作台</button><p role="alert" aria-live="polite"></p></form><p class="subtle">连接码仅用一次，五分钟内有效。不要把它发给别人。</p><details><summary>入口过期了怎么办</summary><p>重新打开本机启动入口，或请维护人员刷新入口。已有任务不需要重新开始。</p><details><summary>刷新命令（供技术人员使用）</summary><p>使用工作台原来的资料文件夹：</p><pre>SYNPLEX_WORKSPACE_DATA_DIR=你的数据目录 npm run connect:workspace</pre></details></details></div>`;
}

export function showStartupFailure(app,{error,describe,retry}){
 app.innerHTML=`<div class="connection-screen" role="alert"><img src="/brand/logo-mark.png" alt="Synplex"><h1>暂时无法打开工作台</h1><p data-startup-message></p><p>已保存的内容仍保留。重试只重新读取页面，不会重新执行任务，也不用重新填写连接码。</p><button type="button" data-startup-retry data-ai-id="workspace-startup-retry" data-ai-role="button" data-ai-action="retry_workspace_load">重新加载</button></div>`;
 app.querySelector('[data-startup-message]').textContent=describe(error);
 const button=app.querySelector('[data-startup-retry]');
 button.onclick=async()=>{button.disabled=true;await retry();};
}
