import { ProtocolError, payloadHash, validateWire } from '../contracts/validate.mjs';

export const fail = (code, message, nextAction) => { throw new ProtocolError(code, message, nextAction); };
export const sameScope = (a, b) => payloadHash(a) === payloadHash(b);
export function checkSnapshot(state, initial) {
  if (!sameScope(state.scope, initial.scope) || state.stateRevision !== initial.stateRevision || state.permissionRevision !== initial.permissionRevision)
    fail('stale_context', '读取期间项目或权限已更新。', '读取最新进展后重新准备背景。');
}
function checkPage(page, state, seen) {
  if (page.stateRevision !== state.stateRevision) fail('stale_context', '读取期间项目已更新。', '重新读取项目。');
  if (!Array.isArray(page.items) || page.items.length > 100 || page.cursor !== null && (typeof page.cursor !== 'string' || !page.cursor.length || seen.has(page.cursor)))
    fail('conflict', '分页结果没有继续前进或格式不完整。', '核对仓库的分页实现。');
  seen.add(page.cursor);
}
export async function occurrences(repo, state) {
  state = structuredClone(state);
  checkSnapshot(await repo.getState(), state);
  const items = []; let cursor = null; const seen = new Set();
  do {
    const page = await repo.listOccurrences({ cursor, limit: 100 });
    checkPage(page, state, seen);
    for (const item of page.items) {
      validateWire('Occurrence', item);
      if (!sameScope(item.scope, repo.scope)) fail('scope_denied', '来源不属于当前范围。', '选择当前项目、版本和分支中的来源。');
      items.push(item);
    }
    cursor = page.cursor;
  } while (cursor !== null);
  checkSnapshot(await repo.getState(), state);
  return items;
}
export async function evidencePages(repo, query, state, maxHits = 1000) {
  if (!Number.isSafeInteger(maxHits) || maxHits < 1 || maxHits > 1000) fail('validation_failed', '检索数量需为1到1000。', '提供明确的检索上限。');
  state = structuredClone(state); query = structuredClone(query);
  checkSnapshot(await repo.getState(), state);
  const items = []; let cursor = null, partial = false; const seen = new Set();
  do {
    // The repository binds cursors to the page limit; keep it constant across pages.
    const page = await repo.queryEvidence({ ...query, cursor, limit: 100 });
    checkPage(page, state, seen);
    for (const item of page.items) {
      validateWire('EvidenceHit', item);
      if (!sameScope(item.occurrence.scope, repo.scope)) fail('scope_denied', '检索结果不属于当前范围。', '核对当前项目、版本和分支。');
    }
    const remaining = maxHits - items.length;
    items.push(...page.items.slice(0, remaining)); cursor = page.cursor;
    if (page.items.length > remaining || items.length === maxHits && cursor !== null) { partial = true; break; }
  } while (cursor !== null);
  checkSnapshot(await repo.getState(), state);
  return { items, partial };
}
