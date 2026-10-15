// A native SQLite transaction coordinates this product's service and offline
// maintenance. No PID files, stale-lock deletion, extra package or model call.
import {DatabaseSync} from 'node:sqlite';
import {constants,openSync,closeSync,lstatSync,realpathSync,chmodSync,mkdirSync} from 'node:fs';
import {join,resolve} from 'node:path';

const held=new WeakSet();
export const WORKSPACE_LEASE_FILES=['.workspace-lifecycle.sqlite','.workspace-lifecycle.sqlite-journal','.workspace-lifecycle.sqlite-wal','.workspace-lifecycle.sqlite-shm'];
export function acquireWorkspaceLease(directory,{create=false}={}){
 directory=resolve(directory);
 if(create)mkdirSync(directory,{recursive:true,mode:0o700});
 const rootStat=lstatSync(directory);
 if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||rootStat.uid!==process.getuid()||rootStat.mode&0o077)throw Error('资料文件夹需要仅本人使用，且不能是替身。');
 const root=realpathSync(directory),file=join(root,WORKSPACE_LEASE_FILES[0]);
 let descriptor;
 try{descriptor=openSync(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);}
 catch(error){if(error.code!=='EEXIST')throw error;}
 finally{if(descriptor!==undefined)closeSync(descriptor);}
 const check=()=>{
  const value=lstatSync(file);
  if(!value.isFile()||value.isSymbolicLink()||value.uid!==process.getuid()||value.mode&0o077||value.nlink!==1)throw Error('资料占用记录不安全，未打开或修改项目。');
  return value;
 };
 const identity=check();let db;
 try{
  db=new DatabaseSync(file);chmodSync(file,0o600);
  db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE;');
  const after=check();
  if(identity.dev!==after.dev||identity.ino!==after.ino)throw Error('资料占用记录发生变化，未继续操作。');
 }catch(error){db?.close();throw Error('这份工作台仍在使用或维护，请先正常关闭原窗口，再重试；不会停止其他程序。',{cause:error});}
 let closed=false;
 const lease={root,assert(){
  if(closed)throw Error('资料维护保护已经结束，未继续操作。');
  const current=check();if(identity.dev!==current.dev||identity.ino!==current.ino)throw Error('资料占用记录发生变化，未继续操作。');
 },close(){if(closed)return;closed=true;try{db.exec('ROLLBACK');}finally{db.close();}}};
 held.add(lease);return lease;
}
export function requireWorkspaceLease(lease,directory){
 if(!held.has(lease)||lease.root!==realpathSync(directory))throw Error('资料维护保护不属于当前项目，未继续操作。');
 lease.assert();return lease;
}
