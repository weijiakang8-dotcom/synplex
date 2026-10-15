import {existsSync,realpathSync} from 'node:fs';
import {resolve,dirname,basename,join} from 'node:path';

// macOS aliases /var and /private/var. Resolve the existing ancestor even for a
// destination that does not exist yet, before checking containment or copying.
export function canonicalTarget(path){
 let parent=resolve(path);const missing=[];
 while(!existsSync(parent)){missing.unshift(basename(parent));const next=dirname(parent);if(next===parent)throw new Error('无法定位目标文件夹。');parent=next;}
 return join(realpathSync(parent),...missing);
}
