import { mkdirSync,readFileSync,writeFileSync,renameSync,lstatSync,existsSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { payloadHash,ProtocolError } from '../../packages/contracts/validate.mjs';
const denied=()=>{throw new ProtocolError('scope_denied','没有这个项目的访问权限。','选择自己创建的项目。');};
const privateRead=file=>{const s=lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.mode&0o077||s.uid!==process.getuid())denied();return readFileSync(file,'utf8');};

// Only the explicitly configured local-owner UI can manage its project catalog.
// Each project and each host keeps exact scoped credentials; never wildcard.
export class LocalProjects {
  constructor({repository,dataDir,connection,rootAuth,allowExecution=false}) {
    this.repository=repository;this.dataDir=dataDir;this.file=join(dataDir,'projects.json');this.rootAuth=rootAuth;this.endpoint=connection.endpoint;this.allowExecution=allowExecution;
    this.binding=payloadHash({ownerId:rootAuth.ownerId,actorId:rootAuth.actorId,scope:rootAuth.authorizedScope});
    this.catalog=existsSync(this.file)?JSON.parse(privateRead(this.file)):{binding:this.binding,entries:[{scope:connection.scope,name:'我的项目',requestId:null,uiTokenFile:connection.uiTokenFile,agentTokenFile:connection.agentTokenFile}]};
    if(this.catalog.binding!==this.binding||!Array.isArray(this.catalog.entries))denied();
    if(!existsSync(this.file))this.#save();
  }
  async #check(rootAuth){if(rootAuth!==this.rootAuth)denied();await this.repository.forScope(rootAuth,rootAuth.authorizedScope);}
  #save(){const temporary=this.file+'.'+randomUUID()+'.tmp';writeFileSync(temporary,JSON.stringify(this.catalog,null,2)+'\n',{mode:0o600,flag:'wx'});renameSync(temporary,this.file);}
  async list(rootAuth){await this.#check(rootAuth);return this.catalog.entries.filter(p=>p.status!=='creating').map(({scope,name})=>({scope:structuredClone(scope),name}));}
  async launch(auth,scope){
    // A launcher renews this human's exact existing scope; it cannot select another project.
    if(auth.kind!=='ui'||auth.ownerId!==this.rootAuth.ownerId||auth.actorId!==this.rootAuth.actorId||!auth.capabilities.has('review_memory'))denied();
    await this.repository.forScope(auth,scope);
    return this.select(this.rootAuth,scope);
  }
  async select(rootAuth,scope){
    await this.#check(rootAuth);const p=this.catalog.entries.find(p=>payloadHash(p.scope)===payloadHash(scope));if(!p||p.status==='creating')denied();
    let auth=this.repository.authenticate(privateRead(p.uiTokenFile).trim());await this.repository.forScope(auth,p.scope);
    if(this.allowExecution&&!auth.capabilities.has('execute')){
      const dir=join(this.dataDir,'connections',payloadHash(p.scope));mkdirSync(dir,{mode:0o700,recursive:true});
      const file=join(dir,'ui-execution-token');this.#credential(rootAuth,p.scope,'local-human','ui',['read_memory','write_memory','review_memory','prepare_task','record_result','execute'],file);
      auth=this.repository.authenticate(privateRead(file).trim());
    }
    return {auth,scope:structuredClone(p.scope),name:p.name};
  }
  async connection(rootAuth,scope,host){
    await this.select(rootAuth,scope);if(!['codex','dsh'].includes(host))denied();
    const p=this.catalog.entries.find(p=>payloadHash(p.scope)===payloadHash(scope));
    if(host==='dsh'&&!p.dshTokenFile){
      const dir=join(this.dataDir,'connections',payloadHash(scope));mkdirSync(dir,{mode:0o700,recursive:true});
      const file=join(dir,'dsh-token');this.#credential(rootAuth,scope,'dsh-host','agent',['read_memory','write_memory','prepare_task','record_result'],file);p.dshTokenFile=file;this.#save();
    }
    const tokenFile=host==='dsh'?p.dshTokenFile:p.agentTokenFile;
    const auth=this.repository.authenticate(privateRead(tokenFile).trim());await this.repository.forScope(auth,scope);
    return {endpoint:this.endpoint,scope:structuredClone(scope),tokenFile};
  }
  async create(rootAuth,{requestId,name}) {
    await this.#check(rootAuth);
    if(typeof requestId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(requestId)||typeof name!=='string'||!name.trim()||name.length>80)
      throw new ProtocolError('validation_failed','请填写简短的项目名称。','名称最多80字，保留原请求标识。');
    let entry=this.catalog.entries.find(p=>p.requestId===requestId);
    if(entry&&entry.name!==name.trim())throw new ProtocolError('conflict','同一创建请求的项目名称发生变化。','先查看原项目，不要重复创建。');
    if(entry&&entry.status!=='creating')return this.select(rootAuth,entry.scope);
    if(!entry){
      const scope={projectId:randomUUID(),versionId:null,branchId:null},dir=join(this.dataDir,'connections',payloadHash(scope));
      entry={scope,name:name.trim(),requestId,status:'creating',uiTokenFile:join(dir,'ui-token'),agentTokenFile:join(dir,'codex-token')};
      this.catalog.entries.push(entry);this.#save(); // Save the identity before any credential side effect.
    }
    const {scope}=entry;mkdirSync(join(this.dataDir,'connections',payloadHash(scope)),{mode:0o700,recursive:true});
    const caps=['read_memory','write_memory','prepare_task','record_result'];
    for(const [actorId,kind,capabilities,file] of [['local-human','ui',[...caps,'review_memory'],entry.uiTokenFile],['codex-host','agent',caps,entry.agentTokenFile]]){
      this.#credential(rootAuth,scope,actorId,kind,capabilities,file);
    }
    entry.status='ready';this.#save();return this.select(rootAuth,scope);
  }
  #credential(rootAuth,scope,actorId,kind,capabilities,file){
    if(existsSync(file)){
      const auth=this.repository.authenticate(privateRead(file).trim());
      if(auth.ownerId!==rootAuth.ownerId||auth.actorId!==actorId||auth.kind!==kind||payloadHash(auth.authorizedScope)!==payloadHash(scope)||capabilities.some(c=>!auth.capabilities.has(c)))denied();
      return;
    }
    const key=this.repository.createCredential({ownerId:rootAuth.ownerId,actorId,scope,kind,capabilities});
    try{writeFileSync(file,key.token,{mode:0o600,flag:'wx'});}catch(error){this.repository.revokeCredential(key.id);throw error;}
  }
}
