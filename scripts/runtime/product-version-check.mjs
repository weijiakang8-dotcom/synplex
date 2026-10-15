import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {homedir,tmpdir} from 'node:os';

// Check the target package against the ORIGINAL product binding, not the
// deliberately disabled workspace probe. This invokes configuration checks
// only: no supervisor, database/queue startup, migration, or task submission.
const script=`import {pathToFileURL} from 'node:url';
import {join} from 'node:path';
const [release,dataDir]=process.argv.slice(1);
const {productConfiguration}=await import(pathToFileURL(join(release,'scripts/runtime/product.mjs')).href);
productConfiguration({dataDir});`;

export function verifyProductVersion(release,dataDir){
 if(!existsSync(join(dataDir,'product-start.json')))return;
 if(['open.mjs','product.mjs'].some(name=>!existsSync(join(release,'scripts/runtime',name))))throw Error('这个版本缺少完整启动入口，不能切换。请保留当前版本。');
 const result=spawnSync(process.execPath,['--input-type=module','-e',script,release,dataDir],{
  cwd:release,encoding:'utf8',timeout:40000,maxBuffer:65536,
  env:{PATH:process.env.PATH,HOME:homedir(),TMPDIR:tmpdir(),LANG:process.env.LANG??'en_US.UTF-8',SYNPLEX_TEST_NO_MODELS:'1',PYTHONDONTWRITEBYTECODE:'1'}
 });
 // Never forward paths, configuration, provider responses, or Python stderr.
 if(result.error||result.status!==0)throw Error('这个版本与现有执行环境不兼容，未切换程序。请保留当前版本；如需更换执行后台，请先完成联合备份和专门迁移。');
}
