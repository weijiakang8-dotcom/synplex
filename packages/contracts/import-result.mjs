import { ProtocolError, payloadHash, validateWire } from './validate.mjs';

const sameScope = (a, b) => a.projectId === b.projectId && a.versionId === b.versionId && a.branchId === b.branchId;
function denied() {
  const error = new ProtocolError('scope_denied', '找不到这次导入，或你没有查看权限。', '使用有权限的账号和对应项目。', 'never');
  error.httpStatus = 403;
  return error;
}
function conflict() {
  const error = new ProtocolError('conflict', '导入记录与结果不一致，已有原件需要核对。', '核对操作回执和保存的原件，不要重新执行。', 'lookup_operation');
  error.httpStatus = 409;
  return error;
}

// Trusted repository/service uses this projection; it is not a DB or an ingestion worker.
// auth comes from authenticated connection context. readRecord is read-only storage access.
export async function readImportResult(auth, request, readRecord) {
  validateWire('GetImportResultRequest', request);
  if (!auth?.ownerId || !auth.capabilities?.has('read_memory') || !auth.authorizedScope || !sameScope(auth.authorizedScope, request.scope)) throw denied();
  const record = await readRecord(request.operationId);
  if (!record || record.ownerId !== auth.ownerId || !sameScope(record.scope, request.scope)) throw denied();
  if (record.kind !== 'import_source') {
    throw new ProtocolError('validation_failed', '这次操作不是资料导入。', '请使用资料导入的操作标识。', 'never');
  }
  const body = { operation: record.operation, result: record.result };
  validateWire('ImportOperationResponse', body);
  const { operation, result } = body;
  if (operation.id !== request.operationId || operation.executionStatus !== 'not_started' || operation.writebackStatus !== 'not_required') throw conflict();

  if (['queued', 'running', 'unknown'].includes(operation.status)) {
    if (result !== null || operation.resultId !== null) throw conflict();
    if (operation.status === 'unknown' && (!operation.error || operation.error.retry !== 'lookup_operation')) throw conflict();
    return { status: operation.status === 'unknown' ? 200 : 202, headers: operation.status === 'unknown' ? {} : { 'Retry-After': '2' }, body: structuredClone(body) };
  }
  if (!result || result.id !== operation.resultId || result.operationId !== operation.id) throw conflict();
  const { contentHash, ...content } = result;
  if (payloadHash(content) !== contentHash) throw conflict();
  const expectedStatus = { complete: ['succeeded'], partial: ['succeeded', 'needs_input'], unsupported: ['succeeded', 'needs_input'], failed: ['failed'], cancelled: ['cancelled'] };
  if (!expectedStatus[result.outcome].includes(operation.status)) throw conflict();
  if (result.outcome === 'failed' && (!result.error || !operation.error)) throw conflict();
  if (['complete', 'partial', 'unsupported'].includes(result.outcome) && result.error !== null) throw conflict();
  if (result.parsed) {
    const coverage = result.parsed.coverage;
    if (result.parsed.sourceId !== result.source.id || coverage.totalBytes !== result.source.byteLength || coverage.coveredBytes > coverage.totalBytes) throw conflict();
    if (['complete', 'partial', 'unsupported'].includes(result.outcome) && coverage.status !== result.outcome) throw conflict();
    if (result.outcome === 'complete' && (coverage.coveredBytes !== coverage.totalBytes || coverage.gaps.length !== 0)) throw conflict();
  } else if (['complete', 'partial', 'unsupported'].includes(result.outcome)) throw conflict();
  for (const occurrence of result.occurrences) {
    if (!sameScope(occurrence.scope, request.scope) || occurrence.sourceId !== result.source.id || (occurrence.parsedRevisionId !== null && occurrence.parsedRevisionId !== result.parsed?.id)) throw conflict();
  }
  for (const warning of result.warnings) if (warning.operationId !== null && warning.operationId !== operation.id) throw conflict();
  if (result.outcome === 'partial' && !result.warnings.some(w => w.code === 'partial_parse')) throw conflict();
  if (result.outcome === 'unsupported' && !result.warnings.some(w => w.code === 'unsupported_format')) throw conflict();
  return { status: 200, headers: {}, body: structuredClone(body) };
}
