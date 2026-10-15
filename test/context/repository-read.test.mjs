import test from 'node:test';
import assert from 'node:assert/strict';
import { occurrences, evidencePages } from '../../packages/context/repository-read.mjs';
import { importSource } from '../../packages/ingestion/index.mjs';
import { setup, input, meta, scope, errorIs, wrap } from '../ingestion/helpers.mjs';
const query = { query: '失败', includeHistory: true, occurrenceIds: null };

test('SQLite occurrence pagination retains every event and evidence cap stays exact across pages', async t => {
  const h = await setup(t), out = await importSource(h.repo, input('旧方案失败，决定保留出处。'), await meta(h.repo));
  const { id, recordedAt, scope: ignoredScope, ...base } = out.occurrences[0];
  await h.repo.appendOccurrences(Array.from({ length: 205 }, (_, i) => ({ ...base, eventId: `additional-${i}` })), await meta(h.repo));
  const state = await h.repo.getState(), all = await occurrences(h.repo, state);
  assert.equal(all.length, 206); assert.equal(new Set(all.map(o => o.id)).size, 206);
  let calls = 0;
  const repo = wrap(h.repo, { queryEvidence: async q => { calls++; assert.equal(q.limit, 100); return h.repo.queryEvidence(q); } });
  const partial = await evidencePages(repo, query, state, 125);
  assert.equal(calls, 2); assert.equal(partial.items.length, 125); assert.equal(partial.partial, true);
  const complete = await evidencePages(h.repo, query, state);
  assert.equal(complete.items.length, 206); assert.equal(complete.partial, false);
  assert.equal((await h.repo.getState()).stateRevision, state.stateRevision);
});

test('a changed revision invalidates paging instead of returning mixed snapshots', async t => {
  const h = await setup(t), state = await h.repo.getState();
  const repo = wrap(h.repo, { listOccurrences: async () => ({ items: [], cursor: null, stateRevision: state.stateRevision+1 }) });
  await assert.rejects(occurrences(repo, state), errorIs('stale_context'));
  await importSource(h.repo, input('最新失败'), await meta(h.repo));
  await assert.rejects(evidencePages(h.repo, query, state), errorIs('stale_context'));
});

test('cyclic or incomplete cursors fail without looping indefinitely', async t => {
  const h = await setup(t), state = await h.repo.getState(); let calls = 0;
  const cyclic = async () => { calls++; return { items: [], cursor: 'same-cursor', stateRevision: state.stateRevision }; };
  await assert.rejects(occurrences(wrap(h.repo, { listOccurrences: cyclic }), state), errorIs('conflict'));
  assert.equal(calls, 2); calls = 0;
  await assert.rejects(evidencePages(wrap(h.repo, { queryEvidence: cyclic }), query, state), errorIs('conflict'));
  assert.equal(calls, 2);
  await assert.rejects(occurrences(wrap(h.repo, { listOccurrences: async () => ({ items: [], stateRevision: state.stateRevision }) }), state), errorIs('conflict'));
});

test('final permission check catches revocation after the last real SQLite page', async t => {
  const h = await setup(t); await importSource(h.repo, input('失败资料'), await meta(h.repo));
  const state = await h.repo.getState();
  const repo = wrap(h.repo, { queryEvidence: async q => {
    const page = await h.repo.queryEvidence(q); h.repository.revokeCredential(h.credential.id); return page;
  } });
  await assert.rejects(evidencePages(repo, query, state), errorIs('scope_denied'));
});

test('scope validation rejects foreign occurrences and hits even from an injected repository', async t => {
  const h = await setup(t); await importSource(h.repo, input('失败资料'), await meta(h.repo));
  const state = await h.repo.getState(), page = await h.repo.listOccurrences({ cursor: null, limit: 100 });
  const foreign = { ...page.items[0], scope: { ...scope, versionId: null } };
  await assert.rejects(occurrences(wrap(h.repo, { listOccurrences: async () => ({ ...page, items: [foreign] }) }), state), errorIs('scope_denied'));
  const hits = await h.repo.queryEvidence({ ...query, cursor: null, limit: 100 });
  await assert.rejects(evidencePages(wrap(h.repo, { queryEvidence: async () => ({ ...hits, items: [{ ...hits.items[0], occurrence: foreign }] }) }), query, state), errorIs('scope_denied'));
});

test('invalid hit budgets fail before any repository query', async t => {
  const h = await setup(t), state = await h.repo.getState(); let queried = false;
  const repo = wrap(h.repo, { queryEvidence: async () => { queried = true; throw new Error('should not query'); } });
  for (const value of [0, -1, 1.5, 1001, NaN]) await assert.rejects(evidencePages(repo, query, state, value), errorIs('validation_failed'));
  assert.equal(queried, false);
});
