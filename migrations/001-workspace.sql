CREATE TABLE IF NOT EXISTS schema_versions (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS scopes (
  partition TEXT PRIMARY KEY, owner_id TEXT NOT NULL, scope_json TEXT NOT NULL,
  state_revision INTEGER NOT NULL DEFAULT 0, permission_revision INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credentials (
  id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, partition TEXT NOT NULL REFERENCES scopes(partition),
  actor_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('ui','agent','worker')),
  capabilities_json TEXT NOT NULL, permission_revision INTEGER NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS raw_blobs (
  owner_id TEXT NOT NULL, sha256 TEXT NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(owner_id,sha256)
);
CREATE TABLE IF NOT EXISTS records (
  partition TEXT NOT NULL REFERENCES scopes(partition), kind TEXT NOT NULL, id TEXT NOT NULL,
  identity_key TEXT, payload_hash TEXT NOT NULL, body_json TEXT NOT NULL,
  PRIMARY KEY(partition,kind,id), UNIQUE(partition,kind,identity_key)
);
CREATE TABLE IF NOT EXISTS receipts (
  partition TEXT NOT NULL REFERENCES scopes(partition), method TEXT NOT NULL, request_id TEXT NOT NULL,
  input_hash TEXT NOT NULL, operation_id TEXT NOT NULL, reply_json TEXT NOT NULL,
  PRIMARY KEY(partition,method,request_id)
);
CREATE TABLE IF NOT EXISTS authorizations (
  id TEXT PRIMARY KEY, partition TEXT NOT NULL REFERENCES scopes(partition), actor_id TEXT NOT NULL,
  action TEXT NOT NULL, input_hash TEXT NOT NULL, state_revision INTEGER NOT NULL,
  permission_revision INTEGER NOT NULL, expires_at TEXT NOT NULL, used INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY, partition TEXT NOT NULL REFERENCES scopes(partition), kind TEXT NOT NULL,
  payload_json TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS quarantined_conflicts (
  id TEXT PRIMARY KEY, partition TEXT NOT NULL REFERENCES scopes(partition), kind TEXT NOT NULL,
  identity_key TEXT NOT NULL, existing_hash TEXT NOT NULL, incoming_hash TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS records_scope_kind ON records(partition,kind);
CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(partition,status);
