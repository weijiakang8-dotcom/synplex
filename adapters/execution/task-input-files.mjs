import {mkdirSync,writeFileSync,lstatSync} from 'node:fs';
import {join,basename} from 'node:path';
import {sha256,ProtocolError} from '../../packages/contracts/validate.mjs';

export const TASK_INPUT_DIRECTORY='.synplex-inputs';
export function materializeTaskInputs(workspace,files=[]){
 if(!Array.isArray(files)||files.length>30)throw new TypeError('Invalid input files');
 let total=0;const paths=[];
 for(const [index,file] of files.entries()){
  if(!(file.bytes instanceof Uint8Array)||sha256(file.bytes)!==file.sha256||(total+=file.bytes.byteLength)>64*1024*1024)
   throw new ProtocolError('conflict','前置文件不完整。','核对已保存的文件，本次没有开工。');
  // Neither filenames nor imported text can choose a path outside this root.
  const name=basename(String(file.name).replaceAll('\\','/')).replace(/[^\p{L}\p{N}._-]/gu,'_').slice(-120)||'资料';
  const root=join(workspace,TASK_INPUT_DIRECTORY);mkdirSync(root,{recursive:true,mode:0o700});if(lstatSync(root).isSymbolicLink())throw new Error('Input root cannot be a link');
  const relative=`${TASK_INPUT_DIRECTORY}/${index+1}-${name}`;
  writeFileSync(join(workspace,relative),file.bytes,{flag:'wx',mode:0o400});
  paths.push({...(file.sourceId?{sourceId:file.sourceId,occurrenceId:file.occurrenceId}:{resultId:file.resultId,artifactId:file.artifactId}),path:relative,sha256:file.sha256});
 }
 return paths;
}
