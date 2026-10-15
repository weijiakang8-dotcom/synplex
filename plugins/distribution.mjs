import { mkdtempSync,writeFileSync,readFileSync,rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { buildCodex } from './build-codex.mjs';
import { buildDsh } from './build-dsh.mjs';
export async function buildDistribution(host,connection){
  if(!['codex','dsh'].includes(host))throw new TypeError('Unknown extension host');
  const dir=mkdtempSync(join(tmpdir(),'synplex-distribution-')),bundle=join(dir,'synplex-'+host),archive=join(dir,'extension.tgz');
  try{
    if(host==='codex')buildCodex(bundle,{endpoint:connection.endpoint,scope:connection.scope,agentTokenFile:connection.tokenFile});
    else{const file=join(dir,'private-connection.json');writeFileSync(file,JSON.stringify(connection),{mode:0o600});buildDsh(bundle,file);}
    await new Promise((resolve,reject)=>{const p=spawn('/usr/bin/tar',['-czf',archive,'-C',dir,'synplex-'+host],{stdio:'ignore'});p.once('error',reject);p.once('exit',code=>code===0?resolve():reject(new Error('安装包生成失败，请稍后重试。')));});
    return readFileSync(archive);
  }finally{rmSync(dir,{recursive:true,force:true});}
}
