// SQLite schema (req §5 data model, §12, §19). NON-SECRET only. There is
// intentionally no column for any token, password, key, cookie, or fingerprint
// secret value. Secrets live in the vault; only vault REFS (not values) may be
// referenced here, and we prefer to keep even refs derivable rather than stored.

export const MIGRATIONS: { id: number; sql: string }[] = [
  {
    id: 1,
    sql: `
CREATE TABLE IF NOT EXISTS connection (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  node TEXT NOT NULL,
  token_id TEXT NOT NULL,
  cert_fingerprint TEXT,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS network_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  mode TEXT NOT NULL,
  subnet_cidr TEXT,
  gateway TEXT,
  address TEXT,
  vmid_rule_json TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS router_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  base_url TEXT NOT NULL,
  scheme TEXT NOT NULL,
  pinned_cert_fingerprint TEXT,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow (
  id TEXT PRIMARY KEY,
  router_profile_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  version INTEGER NOT NULL,
  steps_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS router_chain (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  hops_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS recipe (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  source TEXT NOT NULL,
  checksum TEXT NOT NULL,
  json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  state TEXT NOT NULL,
  target_vmid INTEGER,
  local_address TEXT,
  public_address_sim TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_transition (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  from_state TEXT,
  to_state TEXT NOT NULL,
  reason_sanitized TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS deployment_log (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  level TEXT NOT NULL,
  message_sanitized TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS operation (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  upid TEXT,
  status TEXT NOT NULL,
  started_at TEXT NOT NULL,
  observed_result_sanitized TEXT,
  reconciled_at TEXT
);

CREATE TABLE IF NOT EXISTS mapping_record (
  id TEXT PRIMARY KEY,
  deployment_id TEXT NOT NULL,
  hop_index INTEGER NOT NULL,
  router_profile_id TEXT NOT NULL,
  listen_address TEXT NOT NULL,
  listen_port INTEGER NOT NULL,
  target_address TEXT NOT NULL,
  target_port INTEGER NOT NULL,
  protocol TEXT NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  verified INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL,
  detail_sanitized TEXT NOT NULL,
  at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS vault_meta (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  format_version INTEGER NOT NULL,
  status TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_transition_dep ON deployment_transition(deployment_id, at);
CREATE INDEX IF NOT EXISTS idx_log_dep ON deployment_log(deployment_id, at);
CREATE INDEX IF NOT EXISTS idx_operation_dep ON operation(deployment_id);
CREATE INDEX IF NOT EXISTS idx_mapping_dep ON mapping_record(deployment_id, hop_index);
`,
  },
];

// Column names that would indicate a secret leaked into SQLite. A test asserts
// none of these exist (req §12.2).
export const FORBIDDEN_SECRET_COLUMNS = [
  "password",
  "secret",
  "token_secret",
  "private_key",
  "cookie",
  "csrf",
  "master_key",
];
