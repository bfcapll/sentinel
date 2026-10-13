/**
 * Forward-only migrations. Never edit a shipped migration; append a new one.
 * Tables follow PLAN.md §4, plus `kv` and `telegram_message` which the Telegram
 * layer and digest job need to survive restarts.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
CREATE TABLE cursor (
  chain        TEXT PRIMARY KEY,
  block_number INTEGER NOT NULL,
  block_hash   TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
);

CREATE TABLE block_log (
  number      INTEGER PRIMARY KEY,
  hash        TEXT NOT NULL,
  parent_hash TEXT NOT NULL
);

CREATE TABLE snapshot (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  block      INTEGER NOT NULL,
  ts         INTEGER NOT NULL
);

CREATE TABLE snapshot_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  key       TEXT NOT NULL,
  value_num REAL NOT NULL,
  block     INTEGER NOT NULL,
  ts        INTEGER NOT NULL
);
CREATE INDEX snapshot_history_key_ts ON snapshot_history(key, ts);

CREATE TABLE observation (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  holding      TEXT NOT NULL,
  watcher      TEXT NOT NULL,
  kind         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  tx_hash      TEXT,
  log_index    INTEGER,
  block        INTEGER NOT NULL,
  ts           INTEGER NOT NULL
);
CREATE INDEX observation_holding_block ON observation(holding, block);
CREATE INDEX observation_ts ON observation(ts);

CREATE TABLE condition (
  condition_key      TEXT PRIMARY KEY,
  holding            TEXT NOT NULL,
  watcher            TEXT NOT NULL,
  rule               TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN ('open','closed')),
  tier               TEXT CHECK (tier IN ('P0','P1','P2')),
  opened_at          INTEGER,
  opened_block       INTEGER,
  last_seen_at       INTEGER NOT NULL,
  breach_count       INTEGER NOT NULL DEFAULT 0,
  breach_start_block INTEGER,
  clear_count        INTEGER NOT NULL DEFAULT 0,
  cooldown_until     INTEGER NOT NULL DEFAULT 0,
  exit_blocking      INTEGER NOT NULL DEFAULT 0,
  payload_json       TEXT
);
CREATE INDEX condition_status ON condition(status);

CREATE TABLE alert (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  condition_key       TEXT NOT NULL,
  tier                TEXT NOT NULL CHECK (tier IN ('P0','P1','P2')),
  holding             TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('open','escalation')),
  is_ops              INTEGER NOT NULL DEFAULT 0,
  exposure_usd        REAL,
  exit_path_open      INTEGER,
  title               TEXT NOT NULL,
  message             TEXT NOT NULL,
  block               INTEGER,
  tx_hash             TEXT,
  telegram_chat       TEXT,
  telegram_msg_id     INTEGER,
  fired_at            INTEGER NOT NULL,
  resolved_at         INTEGER,
  resolve_reason      TEXT,
  repeat_count        INTEGER NOT NULL DEFAULT 0,
  send_state          TEXT NOT NULL CHECK (send_state IN ('pending','sent','digest','failed')),
  send_attempts       INTEGER NOT NULL DEFAULT 0,
  next_send_at        INTEGER NOT NULL DEFAULT 0,
  last_sent_at        INTEGER,
  acked_at            INTEGER,
  snoozed_until       INTEGER,
  superseded_by       INTEGER,
  resolve_notice      TEXT NOT NULL DEFAULT 'none' CHECK (resolve_notice IN ('none','pending','sent'))
);
CREATE INDEX alert_key ON alert(condition_key);
CREATE INDEX alert_send_state ON alert(send_state);
CREATE INDEX alert_fired ON alert(fired_at);

CREATE TABLE ack (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER NOT NULL REFERENCES alert(id),
  user_id  INTEGER NOT NULL,
  via      TEXT NOT NULL CHECK (via IN ('button','command')),
  at       INTEGER NOT NULL
);
CREATE INDEX ack_alert ON ack(alert_id);

CREATE TABLE pending_action (
  id               TEXT PRIMARY KEY,
  holding          TEXT NOT NULL,
  source           TEXT NOT NULL,
  target           TEXT NOT NULL,
  selector         TEXT,
  decoded_json     TEXT,
  eta              INTEGER,
  status           TEXT NOT NULL CHECK (status IN ('queued','executed','cancelled','expired')),
  first_seen_block INTEGER NOT NULL
);
CREATE INDEX pending_action_status ON pending_action(status);

CREATE TABLE rpc_health (
  provider   TEXT PRIMARY KEY,
  head       INTEGER,
  lag        INTEGER,
  errors_1m  INTEGER NOT NULL DEFAULT 0,
  ts         INTEGER NOT NULL
);

CREATE TABLE outbox (
  alert_id    INTEGER PRIMARY KEY REFERENCES alert(id),
  status      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  consumed_at INTEGER
);

CREATE TABLE holder_cache (
  asset   TEXT NOT NULL,
  address TEXT NOT NULL,
  balance TEXT NOT NULL,
  rank    INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (asset, address)
);

CREATE TABLE telegram_message (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id   INTEGER NOT NULL REFERENCES alert(id),
  bot        TEXT NOT NULL CHECK (bot IN ('p0','p1','p2')),
  chat_id    TEXT NOT NULL,
  message_id INTEGER NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('open','repeat','resolved')),
  live       INTEGER NOT NULL DEFAULT 1,
  sent_at    INTEGER NOT NULL
);
CREATE INDEX telegram_message_alert ON telegram_message(alert_id);

CREATE TABLE kv (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
`,
  },
];
