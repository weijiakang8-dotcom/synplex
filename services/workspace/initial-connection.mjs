import {existsSync,mkdirSync,readFileSync,writeFileSync,lstatSync} from 'node:fs';
import {join} from 'node:path';
import {payloadHash} from '../../packages/contracts/validate.mjs';

// Shared by ordinary startup and the fresh full-product installer. This does
// not migrate, rewrite credentials, discover keys or start an execution.
export function initialConnection(repository,{dataDir,scope,port,ownerId='local-owner',actorId='local-human'}){
 const file=join(dataDir,'connection.json');let connection;
 if(existsSync(file)){
  const stat=lstatSync(file);if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==process.getuid()||stat.mode&0o077)throw new Error('请使用仅本人可读的工作台连接文件。');
  connection=JSON.parse(readFileSync(file,'utf8'));
  if(payloadHash(connection.scope)!==payloadHash(scope))throw new Error('已有资料属于其他项目，请使用原来的项目设置。');
 }else{
  const capabilities=['read_memory','write_memory','prepare_task','record_result'];
  const ui=repository.createCredential({ownerId,actorId,scope,capabilities:[...capabilities,'review_memory'],kind:'ui'});
  const agent=repository.createCredential({ownerId,actorId:'codex-host',scope,capabilities,kind:'agent'});
  const directory=join(dataDir,'connections');mkdirSync(directory,{mode:0o700});
  const uiTokenFile=join(directory,'ui-token'),agentTokenFile=join(directory,'codex-token');
  writeFileSync(uiTokenFile,ui.token,{flag:'wx',mode:0o600});writeFileSync(agentTokenFile,agent.token,{flag:'wx',mode:0o600});
  connection={endpoint:`http://127.0.0.1:${port}`,scope,uiTokenFile,agentTokenFile};
  writeFileSync(file,JSON.stringify(connection,null,2),{flag:'wx',mode:0o600});
 }
 if(connection.endpoint!==`http://127.0.0.1:${port}`)throw new Error('已有连接使用不同地址，请核对原设置，不会自动修改。');
 return connection;
}
