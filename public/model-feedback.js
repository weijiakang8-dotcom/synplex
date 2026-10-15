// Fixed messages shared by the server and browser. No provider payloads,
// credentials or raw exceptions may be interpolated into these strings.
export const MODEL_CONNECTION_MESSAGES=Object.freeze({
 network:'暂时连接不上模型服务，请检查网络和服务地址后再试。',
 address:'模型服务地址指向了非公开网络，无法连接。请填写服务商的公开地址。',
 fakeDns:'当前网络把模型地址转成了虚拟地址，暂时无法确认真实地址。请稍后重试或检查网络代理。',
 denied:'访问密钥无效或没有查询权限，请检查密钥及账号权限。',
 limited:'服务商限制了请求，或账号额度不足。请稍后重试并检查账号状态。',
 noCatalog:'这个地址未提供所需的模型服务，请检查服务地址。查询型号时，也可按服务商说明手动填写。',
 unavailable:'模型服务暂时不可用，请稍后重试。',
 response:'没有读到可识别的型号列表，请查看服务商说明，或手动填写型号。',
 empty:'这个账号没有返回可用型号，请检查账号权限，或手动填写已开通的型号。',
});
const knownMessages=new Set(Object.values(MODEL_CONNECTION_MESSAGES));
export const knownModelMessage=value=>typeof value==='string'&&knownMessages.has(value);
