import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicAccessOptions,uiSessionCookie} from '../../services/workspace/public-access.mjs';
test('HTTPS proxy opt-in preserves local defaults and secure cookie boundaries',()=>{
 assert.deepEqual(publicAccessOptions({}),{allowedOrigins:[],secureCookies:false});
 assert.deepEqual(publicAccessOptions({SYNPLEX_PUBLIC_ORIGIN:'https://synplex.xyz'}),{allowedOrigins:['https://synplex.xyz'],secureCookies:true});
 for(const origin of ['http://synplex.xyz','https://synplex.xyz/','https://synplex.xyz/path','https://a:b@synplex.xyz','https://synplex.xyz?x=1'])assert.throws(()=>publicAccessOptions({SYNPLEX_PUBLIC_ORIGIN:origin}));
 assert.equal(uiSessionCookie('example',{secureCookies:true}),'synplex_ui=example; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=28800; Secure');
 assert.equal(uiSessionCookie('',{secureCookies:true,maxAge:0}),'synplex_ui=; HttpOnly; SameSite=Strict; Path=/api/; Max-Age=0; Secure');
 assert.ok(!uiSessionCookie('local').includes('; Secure'));
});
