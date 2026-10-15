import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicAccessOptions,uiSessionCookie,uiSessionCookieName} from '../../services/workspace/public-access.mjs';
test('HTTPS proxy opt-in preserves local defaults and secure cookie boundaries',()=>{
 assert.deepEqual(publicAccessOptions({}),{allowedOrigins:[],secureCookies:false});
 assert.deepEqual(publicAccessOptions({SYNPLEX_PUBLIC_ORIGIN:'https://synplex.xyz'}),{allowedOrigins:['https://synplex.xyz'],secureCookies:true});
 for(const origin of ['http://synplex.xyz','https://synplex.xyz/','https://synplex.xyz/path','https://a:b@synplex.xyz','https://synplex.xyz?x=1'])assert.throws(()=>publicAccessOptions({SYNPLEX_PUBLIC_ORIGIN:origin}));
 assert.equal(uiSessionCookie('example',{secureCookies:true,port:5200}),'synplex_ui_5200=example; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=28800; Secure');
 assert.equal(uiSessionCookie('',{secureCookies:true,maxAge:0,port:5200}),'synplex_ui_5200=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0; Secure');
 assert.ok(!uiSessionCookie('local',{port:5280}).includes('; Secure'));
 assert.notEqual(uiSessionCookieName(5202),uiSessionCookieName(5280));
 for(const port of [undefined,0,1023,65536,'5280'])assert.throws(()=>uiSessionCookieName(port));
});
