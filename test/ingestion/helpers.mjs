import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceRepository } from '../../services/workspace/repository.mjs';

export const scope = { projectId: 'dsh-stage', versionId: 'v2', branchId: null };
export const errorIs = code => error => error.code === code;
export const metadata = (extra = {}) => ({ format: 'text/plain', sourceSystem: 'isolated-test', formatVersion: '1',
  sessionId: 'synthetic-session', eventId: randomUUID(), occurredAt: null, importOrigin: 'isolated_test', ...extra });
export const input = (text, extra = {}) => ({ bytes: Buffer.from(text), ...metadata(extra) });
export const meta = async repo => ({ requestId: randomUUID(), expectedStateRevision: (await repo.getState()).stateRevision });
export const wrap = (repo, overrides) => new Proxy(repo, { get(target, key) {
  if (Object.hasOwn(overrides, key)) return overrides[key];
  const value = Reflect.get(target, key, target); return typeof value === 'function' ? value.bind(target) : value;
} });
export async function setup(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'synplex-dsh-stage-'));
  const h = { dataDir, repository: new WorkspaceRepository({ dataDir }) };
  t.after(() => {
    try { h.repository.close(); } finally {
      assert.equal(dirname(resolve(dataDir)), resolve(tmpdir()));
      assert.ok(basename(dataDir).startsWith('synplex-dsh-stage-'));
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
  h.credential = h.repository.createCredential({ ownerId: 'test-owner', actorId: 'test-ui', scope,
    kind: 'ui', capabilities: ['read_memory','write_memory','review_memory'] });
  h.reopen = async () => {
    h.repository.close(); h.repository = new WorkspaceRepository({ dataDir });
    h.auth = h.repository.authenticate(h.credential.token); h.repo = await h.repository.forScope(h.auth, scope);
  };
  h.auth = h.repository.authenticate(h.credential.token); h.repo = await h.repository.forScope(h.auth, scope);
  return h;
}
