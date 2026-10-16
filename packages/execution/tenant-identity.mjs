import {createHash} from 'node:crypto';
export function engineTenantId(owner){
 const hex=createHash('sha256').update('synplex.engine.tenant/1:'+owner).digest('hex');
 return hex.slice(0,8)+'-'+hex.slice(8,12)+'-4'+hex.slice(13,16)+'-a'+hex.slice(17,20)+'-'+hex.slice(20,32);
}
