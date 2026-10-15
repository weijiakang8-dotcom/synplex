// Optional HTTPS reverse-proxy origin. Loopback socket/Host checks stay intact.
export function publicAccessOptions(env=process.env){
 const raw=env.SYNPLEX_PUBLIC_ORIGIN;
 if(!raw)return {allowedOrigins:[],secureCookies:false};
 const url=new URL(raw);
 if(url.protocol!=='https:'||url.origin!==raw||url.username||url.password)throw Error('公网入口必须是准确的 HTTPS 地址，不能包含路径或登录信息。');
 return {allowedOrigins:[url.origin],secureCookies:true};
}
export function uiSessionCookie(id,{secureCookies=false,maxAge=28800}={}){
 return `synplex_ui=${id}; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=${maxAge}${secureCookies?'; Secure':''}`;
}

export const buildInformation=(env=process.env)=>({buildSha:env.SYNPLEX_BUILD_SHA??null});
