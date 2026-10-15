import {request} from 'node:https';
import {isIP} from 'node:net';
import {modelConnectionFailure} from './model-error.mjs';

export const proxyDnsAddress=address=>isIP(address)===4&&/^198\.(18|19)\./.test(address);

// Only a hostname is sent to this fixed, TLS-authenticated resolver. No model
// key, chat text, custom endpoint path or proxy configuration is forwarded.
// Used only when every system DNS answer is a benchmark/fake-IP address.
export function resolveProxyHostname(hostname,{send=request}={}){
 return new Promise((resolve,reject)=>{
  const url=new URL('https://1.1.1.1/dns-query');url.searchParams.set('name',hostname);url.searchParams.set('type','A');
  const failed=()=>modelConnectionFailure('fakeDns');
  const req=send(url,{method:'GET',agent:false,maxHeaderSize:8192,headers:{Accept:'application/dns-json','Accept-Encoding':'identity'}},res=>{
   if(res.statusCode!==200||!/^application\/(?:dns-)?json(?:;|$)/i.test(res.headers['content-type']??'')){res.destroy();reject(failed());return;}
   const chunks=[];let size=0;
   res.on('data',bytes=>{size+=bytes.length;if(size>32768){res.destroy(failed());return;}chunks.push(bytes);});
   res.on('error',()=>reject(failed()));res.on('aborted',()=>reject(failed()));
   res.on('end',()=>{try{resolve(parseProxyDnsReply(Buffer.concat(chunks).toString('utf8'),hostname));}catch{reject(failed());}});
  });
  const timer=setTimeout(()=>req.destroy(failed()),8000);req.once('close',()=>clearTimeout(timer));req.once('error',()=>reject(failed()));req.end();
 });
}

export function parseProxyDnsReply(text,hostname){
 const data=JSON.parse(text),question=data.Question?.[0]??data.Question;
 if(data.Status!==0||data.TC===true||question?.name?.toLowerCase().replace(/\.$/,'')!==hostname.toLowerCase()||question.type!==1||!Array.isArray(data.Answer)||data.Answer.length>64)throw modelConnectionFailure('fakeDns');
 // Follow only the returned name's exact CNAME chain; unrelated answers may
 // not become connection targets. Public/private validation happens next.
 const answers=data.Answer;let name=hostname.toLowerCase(),seen=new Set();
 for(let i=0;i<12;i++){
  if(seen.has(name))break;seen.add(name);
  const records=answers.filter(a=>typeof a.name==='string'&&a.name.toLowerCase().replace(/\.$/,'')===name);
  const addresses=records.filter(a=>a.type===1).map(a=>({address:a.data,family:4}));
  if(addresses.length){if(addresses.some(a=>isIP(a.address)!==4))break;return addresses;}
  const aliases=records.filter(a=>a.type===5&&typeof a.data==='string');if(aliases.length!==1)break;name=aliases[0].data.toLowerCase().replace(/\.$/,'');
 }
 throw modelConnectionFailure('fakeDns');
}
