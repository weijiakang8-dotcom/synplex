import {existsSync,lstatSync,mkdirSync,writeFileSync,unlinkSync} from 'node:fs';
import {join,resolve,sep,dirname} from 'node:path';
import {canonicalTarget} from '../scripts/runtime/paths.mjs';

export function privateTokenPath(file){
 const stat=lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.mode&0o077||stat.uid!==process.getuid())throw new Error('项目连接文件需要仅本人可读；不会把凭据内容放入安装包。');
 return resolve(file);
}
export function reserveBundle(target,sourceRoot){
 const resolved=resolve(target),canonical=canonicalTarget(resolved),source=canonicalTarget(sourceRoot);
 // Include dangling links: existsSync alone would silently follow them later.
 let occupied=existsSync(canonical);try{lstatSync(resolved);occupied=true;}catch(error){if(error.code!=='ENOENT')throw error;}
 if(occupied||source===canonical||source.startsWith(canonical+sep)||canonical.startsWith(source+sep)&&!canonical.startsWith(join(source,'.runtime')+sep))throw new Error('安装包需要全新的独立文件夹；已有内容不会覆盖，请保留原包并选择新位置。');
 mkdirSync(dirname(canonical),{recursive:true,mode:0o700});mkdirSync(canonical,{mode:0o700});writeFileSync(join(canonical,'bundle-incomplete.json'),'{}',{flag:'wx',mode:0o600});return canonical;
}
export function completeBundle(target){unlinkSync(join(target,'bundle-incomplete.json'));}
