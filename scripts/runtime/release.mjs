import {existsSync,lstatSync,readdirSync,readFileSync,writeFileSync,mkdirSync,copyFileSync,chmodSync,readlinkSync,symlinkSync,realpathSync,unlinkSync} from 'node:fs';
import {resolve,join,relative,dirname,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {sha256,payloadHash} from '../../packages/contracts/hash.mjs';
import {canonicalTarget} from './paths.mjs';
import {releaseFeatures,verifyFeatureDeclaration} from './data-compatibility.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const roots=['services','packages','public','migrations','adapters','plugins','integrations','scripts','test','docs','deploy'];
const files=['package.json','package-lock.json','README.md','server.mjs','seed.mjs','打开Synplex.command','检查工作台.command','LICENSE','THIRD_PARTY_NOTICES.md','SECURITY.md','CHANGELOG.md','.env.example'];
function inventory(dir){
 const out=[];const walk=d=>{for(const name of readdirSync(d).sort()){if(d===dir&&['release.json','.runtime'].includes(name))continue;const path=join(d,name),s=lstatSync(path);if(s.isSymbolicLink()){const link=readlinkSync(path);if(!realpathSync(path).startsWith(realpathSync(dir)+sep))throw new Error('发行包含指向外部的替身。');out.push({path:relative(dir,path),link});}else if(s.isDirectory())walk(path);else if(s.isFile())out.push({path:relative(dir,path),sha256:sha256(readFileSync(path)),byteLength:s.size,executable:!!(s.mode&0o111)});else throw new Error('发行内容含特殊文件。');}};walk(dir);return out;
}
function copyTree(from,to,{dependency=false,engine=false}={}){
 const walk=(a,b)=>{const s=lstatSync(a);if(s.isSymbolicLink()){if(!dependency||!realpathSync(a).startsWith(realpathSync(from)+sep))throw new Error('源码或依赖包含外部替身，不能打包。');mkdirSync(dirname(b),{recursive:true});symlinkSync(readlinkSync(a),b);}else if(s.isDirectory()){mkdirSync(b,{recursive:true});for(const n of readdirSync(a).sort()){if(['.git','__pycache__','.runtime','.env','.DS_Store'].includes(n))continue;if(engine&&!lstatSync(join(a,n)).isDirectory()&&!n.endsWith('.py'))continue;walk(join(a,n),join(b,n));}}else if(s.isFile()){mkdirSync(dirname(b),{recursive:true});copyFileSync(a,b);chmodSync(b,s.mode&0o111?0o755:0o644);}else throw new Error('不能打包特殊文件。');};walk(from,to);
}
function dependencyDirectory(sourceRoot,release){
 if(!release)return join(sourceRoot,'node_modules');
 const manifest=verifyRelease(release);
 if(!manifest.dependenciesBundled)throw Error('复用依赖需要已经核对的同平台完整发行包。');
 for(const name of ['package.json','package-lock.json'])if(sha256(readFileSync(join(sourceRoot,name)))!==sha256(readFileSync(join(release,name))))throw Error('依赖锁或项目声明不同，不能复用旧发行依赖。');
 return join(release,'node_modules');
}
export function buildRelease(target,{sourceRoot=root,includeDependencies=false,engineSource=null,dependencyRelease}={}){
 sourceRoot=realpathSync(resolve(sourceRoot));target=canonicalTarget(target);if(existsSync(target)||target===sourceRoot||sourceRoot.startsWith(target+sep)||target.startsWith(sourceRoot+sep)&&!target.startsWith(join(sourceRoot,'.runtime')+sep))throw new Error('发行包必须使用新的独立目录。');
 for(const path of ['package.json','package-lock.json','services/workspace/server.mjs','scripts/runtime/workspace.mjs','scripts/runtime/release.mjs','public/index.html'])if(!existsSync(join(sourceRoot,path)))throw new Error('发行源码不完整，请保留当前版本并核对缺少的文件。');
 mkdirSync(target,{recursive:true,mode:0o700});writeFileSync(join(target,'release-incomplete.json'),'{}',{flag:'wx',mode:0o600});
 for(const name of [...roots,...files])if(existsSync(join(sourceRoot,name)))copyTree(join(sourceRoot,name),join(target,name));
 if(includeDependencies)copyTree(dependencyDirectory(sourceRoot,dependencyRelease),join(target,'node_modules'),{dependency:true});
 if(engineSource){
  engineSource=realpathSync(resolve(engineSource));const to=join(target,'vendor/agenthub/backend');
  for(const name of ['app','alembic'])if(existsSync(join(engineSource,name)))copyTree(join(engineSource,name),join(to,name),{engine:true});
  for(const name of ['requirements.txt','requirements.lock','alembic.ini']){copyTree(join(engineSource,name),join(to,name));}
  copyTree(join(engineSource,'../LICENSE'),join(target,'vendor/agenthub/LICENSE'));
 }
 const top=spawnSync('git',['rev-parse','--show-toplevel'],{cwd:sourceRoot,encoding:'utf8',timeout:10000});
 const ownRepository=top.status===0&&realpathSync(top.stdout.trim())===sourceRoot;
 const git=ownRepository?spawnSync('git',['rev-parse','HEAD'],{cwd:sourceRoot,encoding:'utf8',timeout:10000}):null;
 const status=ownRepository?spawnSync('git',['status','--porcelain'],{cwd:sourceRoot,encoding:'utf8',timeout:10000}):null;
 const sourceCommit=git?.status===0?git.stdout.trim():null,sourceDirty=status?.status===0?!!status.stdout.trim():null;
 const commit=sourceDirty===false?sourceCommit:null;
 const contents=inventory(target).filter(f=>f.path!=='release-incomplete.json');
 const manifest={format:'synplex.local-release/1',createdAt:new Date().toISOString(),commit,sourceCommit,sourceDirty,platform:includeDependencies?process.platform:null,arch:includeDependencies?process.arch:null,
  nodeMinimum:'22.16',dependenciesBundled:includeDependencies,engineSourceIncluded:!!engineSource,engineEnvironmentInstalled:false,
  dataCompatibility:{workspaceSchemaVersions:[1],engineUpgrade:'not_included'},workspaceFeatures:releaseFeatures(target),
  files:contents,contentHash:payloadHash(contents),packagingVerified:true,isolatedStartupVerified:false,fullDeliveryVerified:false,limitation:'发行候选；源码齐全不代表真实执行、独立引擎安装或联合恢复已验收。'};
 writeFileSync(join(target,'release.json'),JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});
 // Leave the candidate marker in place until the complete inventory is verified.
 verifyRelease(target,{allowCandidate:true});unlinkSync(join(target,'release-incomplete.json'));return manifest;
}
export function verifyRelease(target,{allowCandidate=false}={}){
 target=realpathSync(resolve(target));const file=join(target,'release.json');if(lstatSync(file).isSymbolicLink())throw new Error('发行清单不能是替身。');const m=JSON.parse(readFileSync(file,'utf8'));
 if(m.format!=='synplex.local-release/1'||!Array.isArray(m.files)||payloadHash(m.files)!==m.contentHash)throw new Error('发行清单格式或指纹不正确。');
 if(m.dependenciesBundled&&(m.platform!==process.platform||m.arch!==process.arch))throw new Error('这份带依赖的发行包不适用于当前电脑。');
 verifyFeatureDeclaration(target,m);
 const actual=inventory(target).filter(f=>f.path!=='release-incomplete.json');if(payloadHash(actual)!==m.contentHash)throw new Error('发行包文件缺失或被修改，不能启动。');
 if(!allowCandidate&&existsSync(join(target,'release-incomplete.json')))throw new Error('发行包尚未完成验收。');return m;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 try{const args=process.argv.slice(2);if(args[0]==='verify'){verifyRelease(args[1]);console.log('发行包文件核对通过。');}
 else{const engine=args.indexOf('--engine-source');buildRelease(args[0],{includeDependencies:args.includes('--bundle-dependencies'),engineSource:engine<0?null:args[engine+1]});console.log('发行候选已生成；仍需完成隔离启动与验收，不是正式交付。');}}
 catch(error){console.error(error.message);process.exitCode=1;}
}
