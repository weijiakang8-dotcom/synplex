import { ProtocolError, PROTOCOL_VERSION, validateWire } from '../../packages/contracts/validate.mjs';

// Internal service seam. It is deliberately not a new frozen UI or MCP contract.
export function validateExecutionRequest(input, authorized = false) {
  const keys = ['protocolVersion','scope','requestId','expectedStateRevision','runId',...(authorized ? ['authorizationId'] : [])];
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== keys.length ||
      keys.some(k => !Object.hasOwn(input,k)) || Object.keys(input).some(k => !keys.includes(k)) ||
      input.protocolVersion !== PROTOCOL_VERSION || typeof input.runId !== 'string' || !input.runId.length ||
      typeof input.requestId !== 'string' || !input.requestId.length || input.requestId.length > 128 ||
      !Number.isSafeInteger(input.expectedStateRevision) || input.expectedStateRevision < 0 ||
      authorized && (typeof input.authorizationId !== 'string' || !input.authorizationId.length)) {
    throw new ProtocolError('validation_failed','执行请求格式不正确。','保留完整工作说明，使用服务签发的授权。','after_input');
  }
  validateWire('Scope',input.scope);
  return input;
}
