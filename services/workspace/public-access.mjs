// Optional HTTPS reverse-proxy origin. Loopback socket/Host checks stay intact.
export function publicAccessOptions(env=process.env){
 const raw=env.SYNPLEX_PUBLIC_ORIGIN;
 if(!raw)return {allowedOrigins:[],secureCookies:false};
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.origin!==raw||url.username||url.password)throw Error('公网入口必须是准确的 HTTPS 地址，不能包含路径或登录信息。');
 return {allowedOrigins:[url.origin],secureCookies:true};
}
export function uiSessionCookieName(port){
 if(!Number.isInteger(port)||port<1024||port>65535)throw Error('工作台连接地址不正确。');
 // Cookies have no port boundary. Separate local instances must not overwrite
 // each other's browser login; their server-side sessions remain independent.
 return `synplex_ui_${port}`;
}
export function uiSessionCookie(id,{secureCookies=false,maxAge=28800,port}={}){
 return `${uiSessionCookieName(port)}=${id}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=${maxAge}${secureCookies?'; Secure':''}`;
}

export const buildInformation=(env=process.env)=>({buildSha:env.SYNPLEX_BUILD_SHA??null});
