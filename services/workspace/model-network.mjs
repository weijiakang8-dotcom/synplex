import {lookup} from 'node:dns/promises';
import {request} from 'node:https';
import {BlockList,isIP} from 'node:net';
import {validateEndpoint} from './model-contract.mjs';
import {ModelConnectionError,modelConnectionFailure} from './model-error.mjs';
import {proxyDnsAddress,resolveProxyHostname} from './model-dns.mjs';

const excluded=new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',4],['240.0.0.0',4]])excluded.addSubnet(address,prefix,'ipv4');
const globalV6=new BlockList();globalV6.addSubnet('2000::',3,'ipv6');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]])excluded.addSubnet(address,prefix,'ipv6');
export function publicAddress(address){
  const family=isIP(address);if(!family)return false;
  if(family===4)return !excluded.check(address,'ipv4');
  return globalV6.check(address,'ipv6')&&!excluded.check(address,'ipv6');
}
export async function resolvePublic(hostname,resolver=lookup,proxyResolver=resolveProxyHostname){
  const host=hostname.replace(/^\[|\]$/g,'');
  let addresses=isIP(host)?[{address:host,family:isIP(host)}]:await resolver(host,{all:true,verbatim:true});
  if(!isIP(host)&&addresses.length&&addresses.every(a=>proxyDnsAddress(a.address)))addresses=await proxyResolver(host);
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw modelConnectionFailure('address');
  return addresses;
}
const networkFailure=()=>modelConnectionFailure('network');
function streamResponse(response,{onChunk,maxBytes,resolve,reject}){
  if(response.statusCode!==200){response.destroy();reject(modelConnectionFailure(responseFailure(response.statusCode)));return;}
  if(!/^(application\/json|text\/event-stream)(?:;|$)/i.test(response.headers['content-type']??'')){response.destroy();reject(networkFailure());return;}
  let total=0;const chunks=[];
  response.on('data',chunk=>{
    total+=chunk.length;
    if(total>maxBytes){response.destroy(networkFailure());return;}
    if(onChunk){try{onChunk(chunk);}catch{response.destroy(networkFailure());}}else chunks.push(chunk);
  });
  response.on('error',()=>reject(networkFailure()));
  response.on('aborted',()=>reject(networkFailure()));
  response.on('end',()=>resolve(onChunk?null:Buffer.concat(chunks)));
}
function responseFailure(status){
 if(status===401||status===403)return 'denied';
 if(status===429)return 'limited';
 if(status===404||status===405)return 'noCatalog';
 return 'unavailable';
}
// One connection, one vetted DNS answer. The TLS hostname stays the provider's
// hostname. No proxy environment, redirect, SDK retry or automatic fallback.
async function sendModelRequest(resolver,send,proxyResolver,{endpoint,path,secret,body=null,onChunk=null,signal=null,timeoutMs=90000,maxBytes=2*1024*1024}){
  const base=validateEndpoint(endpoint),url=new URL(base+path);
  if(!['/models','/chat/completions','/responses'].includes(path))throw networkFailure();
  if(signal?.aborted)throw networkFailure();
  const started=Date.now();let dnsTimer,onAbort;
  const addresses=await Promise.race([resolvePublic(url.hostname,resolver,proxyResolver),new Promise((_,reject)=>{
    dnsTimer=setTimeout(()=>reject(networkFailure()),Math.min(timeoutMs,10000));
    onAbort=()=>reject(networkFailure());signal?.addEventListener('abort',onAbort,{once:true});
  })]).catch(error=>{throw error instanceof ModelConnectionError?error:networkFailure();}).finally(()=>{clearTimeout(dnsTimer);signal?.removeEventListener('abort',onAbort);});
  if(signal?.aborted||Date.now()-started>=timeoutMs)throw networkFailure();
  const selected=addresses[0];
  const bytes=body===null?null:Buffer.from(JSON.stringify(body));
  return new Promise((resolve,reject)=>{
    const req=send(url,{method:bytes?'POST':'GET',agent:false,maxHeaderSize:16384,signal,
      headers:{Authorization:`Bearer ${secret}`,'Content-Type':'application/json','Accept-Encoding':'identity',...(bytes?{'Content-Length':bytes.length}:{})},
      lookup(_hostname,_options,callback){if(_options.all)callback(null,[selected]);else callback(null,selected.address,selected.family);}},
    response=>streamResponse(response,{onChunk,maxBytes,resolve,reject}));
    const timer=setTimeout(()=>req.destroy(networkFailure()),Math.max(1,timeoutMs-(Date.now()-started)));
    req.once('close',()=>clearTimeout(timer));req.once('error',()=>reject(networkFailure()));
    req.on('socket',socket=>socket.once('secureConnect',()=>{if(socket.remoteAddress!==selected.address)req.destroy(networkFailure());}));
    req.end(bytes);
  });
}

export const createModelTransport=({resolver=lookup,send=request,proxyResolver=resolveProxyHostname}={})=>input=>sendModelRequest(resolver,send,proxyResolver,input);
export const modelRequest=createModelTransport();

// Streaming envelopes may be much larger than the visible answer. Keep a hard
// bound tied to the already-authorized output, including hidden reasoning.
export const modelTransferLimits=tokens=>({timeoutMs:180000,maxBytes:Math.min(32*1024*1024,Math.max(2*1024*1024,tokens*1024))});
