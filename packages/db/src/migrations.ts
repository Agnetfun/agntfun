export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const appendOnly = (table: string) => `
CREATE TRIGGER ${table}_no_update BEFORE UPDATE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;
CREATE TRIGGER ${table}_no_delete BEFORE DELETE ON ${table}
BEGIN SELECT RAISE(ABORT, '${table} is append-only'); END;`;

const v1 = `
CREATE TABLE agents (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'sleeping'
    CHECK (state IN ('sleeping','waking','running','publishing','halted','starved')),
  repo TEXT,
  x_handle TEXT,
  prompt_hash TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  end_reason TEXT,
  task_ref TEXT,
  summary TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_agent ON sessions(agent_id, started_at);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  agent_id TEXT REFERENCES agents(id),
  session_id TEXT REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json))
);
CREATE INDEX idx_events_agent_ts ON events(agent_id, ts);
${appendOnly("events")}

-- Double entry: every txn_id gets balanced debit and credit rows (enforced by the treasury, Phase 5).
CREATE TABLE ledger (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  txn_id TEXT NOT NULL,
  agent_id TEXT REFERENCES agents(id),
  account TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  unit TEXT NOT NULL CHECK (unit IN ('lamports','usdc_micro','usd_cents')),
  direction TEXT NOT NULL CHECK (direction IN ('debit','credit')),
  ref_type TEXT,
  ref_id TEXT,
  operator_id TEXT
);
CREATE INDEX idx_ledger_txn ON ledger(txn_id);
${appendOnly("ledger")}
`;

// Phase 1: model choice per agent, LLM call log, task queue.
const v2 = `
ALTER TABLE agents ADD COLUMN model TEXT NOT NULL DEFAULT 'opus' CHECK (model IN ('opus','astra'));
ALTER TABLE agents ADD COLUMN locked_prompt TEXT NOT NULL DEFAULT '';

CREATE TABLE llm_calls (
  id TEXT PRIMARY KEY,
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  ts INTEGER NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL,
  tokens_out INTEGER NOT NULL,
  cost_micro_usd INTEGER NOT NULL,
  latency_ms INTEGER NOT NULL
);
CREATE INDEX idx_llm_calls_session ON llm_calls(session_id);

CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL CHECK (source IN ('file','proposal')),
  summary TEXT NOT NULL,
  size TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','blocked')),
  created_at INTEGER NOT NULL,
  done_at INTEGER,
  UNIQUE (agent_id, source, summary)
);
`;

// Phase 2: kill switch, gateway rate buckets and audit log.
const v3 = `
CREATE TABLE kill_switches (
  scope TEXT PRIMARY KEY,
  active INTEGER NOT NULL DEFAULT 0 CHECK (active IN (0,1)),
  set_by TEXT,
  set_at INTEGER,
  reason TEXT
);

CREATE TABLE rate_buckets (
  agent_id TEXT NOT NULL,
  action TEXT NOT NULL,
  tokens REAL NOT NULL,
  refilled_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, action)
);

CREATE TABLE gateway_audit (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  agent_id TEXT,
  intent_kind TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  decision TEXT NOT NULL CHECK (decision IN ('allow','deny')),
  stage TEXT,
  reason TEXT,
  result_ref TEXT,
  cost_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_audit_agent ON gateway_audit(agent_id, ts);
${appendOnly("gateway_audit")}
`;

// Phase 3: public posts record (also used for similarity checks and cost metering).
const v4 = `
CREATE TABLE posts (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT REFERENCES sessions(id),
  ts INTEGER NOT NULL,
  text TEXT NOT NULL,
  ref TEXT NOT NULL,
  linked INTEGER NOT NULL DEFAULT 0,
  cost_cents INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_posts_agent ON posts(agent_id, ts);
${appendOnly("posts")}
`;

// Phase 4: community suggestions and holder votes. raw_text is untrusted and never leaves the community package.
const v5 = `
CREATE TABLE suggestions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  author_ref TEXT,
  raw_text TEXT NOT NULL,
  received_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','accepted','rejected','queued')),
  summary TEXT,
  size TEXT,
  category TEXT,
  reject_reason TEXT,
  UNIQUE (agent_id, source, external_id)
);
CREATE INDEX idx_suggestions_agent ON suggestions(agent_id, status);

CREATE TABLE votes (
  id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL REFERENCES suggestions(id),
  voter TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight > 0),
  ts INTEGER NOT NULL,
  UNIQUE (suggestion_id, voter)
);
${appendOnly("votes")}
`;

// Phase 5: duty cycle schedule per agent.
const v6 = `
CREATE TABLE agent_schedule (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  interval_ms INTEGER NOT NULL CHECK (interval_ms > 0),
  next_wake_at INTEGER NOT NULL,
  last_session_id TEXT
);
`;

// Phase 6: launch records and the fee listener cursor.
const v7 = `
CREATE TABLE launches (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  mint TEXT NOT NULL UNIQUE,
  cluster TEXT NOT NULL,
  signature TEXT NOT NULL,
  split_json TEXT NOT NULL CHECK (json_valid(split_json)),
  launched_at INTEGER NOT NULL
);
CREATE TABLE listener_cursor (
  mint TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
`;

// Phase 8b: coin identity (ticker, description, logo).
const v9 = `
ALTER TABLE agents ADD COLUMN ticker TEXT;
ALTER TABLE agents ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN logo_id TEXT;
CREATE TABLE logos (
  id TEXT PRIMARY KEY,
  mime TEXT NOT NULL CHECK (mime IN ('image/png','image/jpeg','image/webp','image/gif')),
  bytes BLOB NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Phase 8: deployers, reports and takedowns.
const v8 = `
ALTER TABLE agents ADD COLUMN deployer TEXT;
ALTER TABLE agents ADD COLUMN removed_at INTEGER;
ALTER TABLE agents ADD COLUMN removed_reason TEXT;
CREATE UNIQUE INDEX idx_agents_name ON agents(lower(name));

CREATE TABLE deploy_nonces (nonce TEXT PRIMARY KEY, ts INTEGER NOT NULL);

CREATE TABLE reports (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  ts INTEGER NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('scam','harmful_content','impersonation','spam','other')),
  detail TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','actioned','dismissed'))
);
CREATE INDEX idx_reports_agent ON reports(agent_id, ts);
`;

// Full dapp: one wallet per agent (secret sealed, only the gateway can open it), sealed per agent credentials,
// price samples read from the chain, a per wallet inflow cursor, and launches waiting for the creator's signature.
const v10 = `
CREATE TABLE agent_wallets (
  agent_id TEXT PRIMARY KEY REFERENCES agents(id),
  address TEXT NOT NULL UNIQUE,
  sealed_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE agent_credentials (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('github','x')),
  sealed TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, kind)
);
CREATE TABLE price_samples (
  mint TEXT NOT NULL,
  ts INTEGER NOT NULL,
  price_sol REAL NOT NULL,
  mcap_sol REAL NOT NULL,
  holders INTEGER NOT NULL DEFAULT 0,
  complete INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mint, ts)
);
CREATE TABLE holder_snapshots (
  mint TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  holders_json TEXT NOT NULL CHECK (json_valid(holders_json))
);
CREATE TABLE wallet_cursor (
  address TEXT PRIMARY KEY,
  last_signature TEXT NOT NULL
);
CREATE TABLE pending_launches (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  step TEXT NOT NULL CHECK (step IN ('create','split')),
  mint TEXT NOT NULL,
  message_b64 TEXT NOT NULL,
  split_json TEXT NOT NULL CHECK (json_valid(split_json)),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, step)
);
`;

// Live agent screen: what each session step showed (files written, test output, commits), already redacted.
const v11 = `
CREATE TABLE live_frames (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX idx_live_agent ON live_frames(agent_id, ts);
`;

// Bankr style money controls: pump.fun fee payout status per coin, and the agent wallet outflow policy
// (caps, recipient allowlist with a cooldown, outflow log).
const v12 = `
CREATE TABLE fee_status (
  mint TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  waiting INTEGER NOT NULL DEFAULT 0,
  can INTEGER NOT NULL DEFAULT 0,
  paid_at INTEGER,
  signature TEXT
);
CREATE TABLE wallet_allowlist (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  address TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  usable_at INTEGER NOT NULL,
  added_by TEXT NOT NULL,
  PRIMARY KEY (agent_id, address)
);
CREATE TABLE wallet_outflows (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  ts INTEGER NOT NULL,
  to_address TEXT NOT NULL,
  lamports INTEGER NOT NULL CHECK (lamports > 0),
  operator TEXT NOT NULL,
  signature TEXT
);
${appendOnly("wallet_outflows")}
`;

// Connect X / GitHub: the connected account name, pending OAuth logins (single use, short lived),
// and the agent's previous repo so work done before connecting GitHub seeds the new repository.
const v13 = `
ALTER TABLE agent_credentials ADD COLUMN account TEXT;
ALTER TABLE agents ADD COLUMN repo_prev TEXT;
CREATE TABLE oauth_states (
  state TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  kind TEXT NOT NULL CHECK (kind IN ('github','x')),
  verifier TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Platform owned wallets (the buyback wallet): sealed like agent wallets, only the gateway can sign.
const v14 = `
CREATE TABLE platform_wallets (
  role TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  sealed_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`;

// Connection health: when an agent's GitHub or X token last worked, and the last auth failure (revoked, expired).
const v15 = `
ALTER TABLE agent_credentials ADD COLUMN last_ok_at INTEGER;
ALTER TABLE agent_credentials ADD COLUMN error_at INTEGER;
ALTER TABLE agent_credentials ADD COLUMN last_error TEXT;
`;

// Triage retries: a failed or garbled model answer is tried again (a few times) instead of rejecting the idea.
const v16 = `
ALTER TABLE suggestions ADD COLUMN triage_attempts INTEGER NOT NULL DEFAULT 0;
`;

export const MIGRATIONS: Migration[] = [
  { version: 1, name: "schema_v0", sql: v1 },
  { version: 2, name: "phase1_llm_tasks", sql: v2 },
  { version: 3, name: "phase2_gateway", sql: v3 },
  { version: 4, name: "phase3_posts", sql: v4 },
  { version: 5, name: "phase4_community", sql: v5 },
  { version: 6, name: "phase5_schedule", sql: v6 },
  { version: 7, name: "phase6_launch", sql: v7 },
  { version: 8, name: "phase8_platform", sql: v8 },
  { version: 9, name: "phase8b_identity", sql: v9 },
  { version: 10, name: "dapp_wallets_market", sql: v10 },
  { version: 11, name: "live_screen", sql: v11 },
  { version: 12, name: "money_controls", sql: v12 },
  { version: 13, name: "connect_accounts", sql: v13 },
  { version: 14, name: "platform_wallets", sql: v14 },
  { version: 15, name: "connection_health", sql: v15 },
  { version: 16, name: "triage_retries", sql: v16 },
];
