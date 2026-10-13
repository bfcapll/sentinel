import type { Db } from './db.js';
import type { AlertContext, ConditionState, Tier } from '../rules/types.js';

const bool = (v: unknown): boolean => v === 1 || v === true;
const json = <T>(s: string | null): T | null => (s === null ? null : (JSON.parse(s) as T));

/* ------------------------------------------------------------------ rows */

export interface AlertRow {
  id: number;
  conditionKey: string;
  tier: Tier;
  holding: string;
  kind: 'open' | 'escalation';
  isOps: boolean;
  exposureUsd: number | null;
  exitPathOpen: boolean | null;
  title: string;
  message: string;
  block: number | null;
  txHash: string | null;
  telegramChat: string | null;
  telegramMsgId: number | null;
  firedAt: number;
  resolvedAt: number | null;
  resolveReason: string | null;
  repeatCount: number;
  sendState: 'pending' | 'sent' | 'digest' | 'failed';
  sendAttempts: number;
  nextSendAt: number;
  lastSentAt: number | null;
  ackedAt: number | null;
  snoozedUntil: number | null;
  supersededBy: number | null;
  resolveNotice: 'none' | 'pending' | 'sent';
}

export interface NewAlert {
  conditionKey: string;
  tier: Tier;
  holding: string;
  kind: 'open' | 'escalation';
  isOps: boolean;
  exposureUsd: number | null;
  exitPathOpen: boolean | null;
  title: string;
  message: string;
  block: number | null;
  txHash: string | null;
  firedAt: number;
  sendState: 'pending' | 'digest';
}

function toAlert(r: Record<string, unknown>): AlertRow {
  return {
    id: r['id'] as number,
    conditionKey: r['condition_key'] as string,
    tier: r['tier'] as Tier,
    holding: r['holding'] as string,
    kind: r['kind'] as 'open' | 'escalation',
    isOps: bool(r['is_ops']),
    exposureUsd: (r['exposure_usd'] as number | null) ?? null,
    exitPathOpen: r['exit_path_open'] === null ? null : bool(r['exit_path_open']),
    title: r['title'] as string,
    message: r['message'] as string,
    block: (r['block'] as number | null) ?? null,
    txHash: (r['tx_hash'] as string | null) ?? null,
    telegramChat: (r['telegram_chat'] as string | null) ?? null,
    telegramMsgId: (r['telegram_msg_id'] as number | null) ?? null,
    firedAt: r['fired_at'] as number,
    resolvedAt: (r['resolved_at'] as number | null) ?? null,
    resolveReason: (r['resolve_reason'] as string | null) ?? null,
    repeatCount: r['repeat_count'] as number,
    sendState: r['send_state'] as AlertRow['sendState'],
    sendAttempts: r['send_attempts'] as number,
    nextSendAt: r['next_send_at'] as number,
    lastSentAt: (r['last_sent_at'] as number | null) ?? null,
    ackedAt: (r['acked_at'] as number | null) ?? null,
    snoozedUntil: (r['snoozed_until'] as number | null) ?? null,
    supersededBy: (r['superseded_by'] as number | null) ?? null,
    resolveNotice: r['resolve_notice'] as AlertRow['resolveNotice'],
  };
}

export interface TelegramMessageRow {
  id: number;
  alertId: number;
  bot: 'p0' | 'p1' | 'p2';
  chatId: string;
  messageId: number;
  kind: 'open' | 'repeat' | 'resolved';
  live: boolean;
  sentAt: number;
}

export interface RpcHealthRow {
  provider: string;
  head: number | null;
  lag: number | null;
  errors1m: number;
  ts: number;
}

export interface PendingActionRow {
  id: string;
  holding: string;
  source: string;
  target: string;
  selector: string | null;
  decoded: unknown;
  eta: number | null;
  status: 'queued' | 'executed' | 'cancelled' | 'expired';
  firstSeenBlock: number;
}

/* ------------------------------------------------------------------ repos */

export class Repos {
  readonly cursor: CursorRepo;
  readonly blockLog: BlockLogRepo;
  readonly snapshot: SnapshotRepo;
  readonly observation: ObservationRepo;
  readonly condition: ConditionRepo;
  readonly alert: AlertRepo;
  readonly ack: AckRepo;
  readonly pendingAction: PendingActionRepo;
  readonly rpcHealth: RpcHealthRepo;
  readonly outbox: OutboxRepo;
  readonly holderCache: HolderCacheRepo;
  readonly telegramMessage: TelegramMessageRepo;
  readonly kv: KvRepo;

  constructor(db: Db) {
    this.cursor = new CursorRepo(db);
    this.blockLog = new BlockLogRepo(db);
    this.snapshot = new SnapshotRepo(db);
    this.observation = new ObservationRepo(db);
    this.condition = new ConditionRepo(db);
    this.alert = new AlertRepo(db);
    this.ack = new AckRepo(db);
    this.pendingAction = new PendingActionRepo(db);
    this.rpcHealth = new RpcHealthRepo(db);
    this.outbox = new OutboxRepo(db);
    this.holderCache = new HolderCacheRepo(db);
    this.telegramMessage = new TelegramMessageRepo(db);
    this.kv = new KvRepo(db);
  }
}

export class CursorRepo {
  constructor(private db: Db) {}
  get(chain: string): { block: number; hash: string; updatedAt: number } | undefined {
    const r = this.db.prepare('SELECT block_number, block_hash, updated_at FROM cursor WHERE chain = ?').get(chain) as
      | { block_number: number; block_hash: string; updated_at: number }
      | undefined;
    return r && { block: r.block_number, hash: r.block_hash, updatedAt: r.updated_at };
  }
  set(chain: string, block: number, hash: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO cursor(chain, block_number, block_hash, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(chain) DO UPDATE SET block_number = excluded.block_number, block_hash = excluded.block_hash, updated_at = excluded.updated_at`,
      )
      .run(chain, block, hash, ts);
  }
}

export class BlockLogRepo {
  constructor(private db: Db) {}
  put(number: number, hash: string, parentHash: string): void {
    this.db
      .prepare(
        `INSERT INTO block_log(number, hash, parent_hash) VALUES (?, ?, ?)
         ON CONFLICT(number) DO UPDATE SET hash = excluded.hash, parent_hash = excluded.parent_hash`,
      )
      .run(number, hash, parentHash);
  }
  get(number: number): { number: number; hash: string; parentHash: string } | undefined {
    const r = this.db.prepare('SELECT number, hash, parent_hash FROM block_log WHERE number = ?').get(number) as
      | { number: number; hash: string; parent_hash: string }
      | undefined;
    return r && { number: r.number, hash: r.hash, parentHash: r.parent_hash };
  }
  deleteAbove(number: number): void {
    this.db.prepare('DELETE FROM block_log WHERE number > ?').run(number);
  }
  /** Keep only the newest `keep` rows (PLAN.md §4: last 64). */
  prune(keep = 64): void {
    this.db.prepare('DELETE FROM block_log WHERE number <= (SELECT MAX(number) FROM block_log) - ?').run(keep);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM block_log').get() as { n: number }).n;
  }
}

export class SnapshotRepo {
  constructor(private db: Db) {}
  get<T = unknown>(key: string): { value: T; block: number; ts: number } | undefined {
    const r = this.db.prepare('SELECT value_json, block, ts FROM snapshot WHERE key = ?').get(key) as
      | { value_json: string; block: number; ts: number }
      | undefined;
    return r && { value: JSON.parse(r.value_json) as T, block: r.block, ts: r.ts };
  }
  /** All snapshot keys with a prefix, as key -> value. */
  byPrefix(prefix: string): Map<string, unknown> {
    const rows = this.db
      .prepare('SELECT key, value_json FROM snapshot WHERE key >= ? AND key < ?')
      .all(prefix, prefix + '￿') as Array<{ key: string; value_json: string }>;
    return new Map(rows.map((r) => [r.key, JSON.parse(r.value_json) as unknown]));
  }
  put(key: string, value: unknown, block: number, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO snapshot(key, value_json, block, ts) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, block = excluded.block, ts = excluded.ts`,
      )
      .run(key, JSON.stringify(value, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)), block, ts);
  }
  addHistory(key: string, valueNum: number, block: number, ts: number): void {
    this.db.prepare('INSERT INTO snapshot_history(key, value_num, block, ts) VALUES (?, ?, ?, ?)').run(key, valueNum, block, ts);
  }
  history(key: string, sinceTs: number): Array<{ value: number; block: number; ts: number }> {
    return (
      this.db
        .prepare('SELECT value_num, block, ts FROM snapshot_history WHERE key = ? AND ts >= ? ORDER BY ts ASC')
        .all(key, sinceTs) as Array<{ value_num: number; block: number; ts: number }>
    ).map((r) => ({ value: r.value_num, block: r.block, ts: r.ts }));
  }
  pruneHistory(olderThanTs: number): number {
    return this.db.prepare('DELETE FROM snapshot_history WHERE ts < ?').run(olderThanTs).changes;
  }
}

export class ObservationRepo {
  constructor(private db: Db) {}
  insert(o: {
    holding: string;
    watcher: string;
    kind: string;
    payload: unknown;
    txHash?: string | null;
    logIndex?: number | null;
    block: number;
    ts: number;
  }): void {
    this.db
      .prepare(
        'INSERT INTO observation(holding, watcher, kind, payload_json, tx_hash, log_index, block, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(o.holding, o.watcher, o.kind, JSON.stringify(o.payload), o.txHash ?? null, o.logIndex ?? null, o.block, o.ts);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM observation').get() as { n: number }).n;
  }
  prune(olderThanTs: number): number {
    return this.db.prepare('DELETE FROM observation WHERE ts < ?').run(olderThanTs).changes;
  }
}

export class ConditionRepo {
  constructor(private db: Db) {}
  private map(r: Record<string, unknown>): ConditionState {
    return {
      key: r['condition_key'] as string,
      holding: r['holding'] as string,
      watcher: r['watcher'] as string,
      rule: r['rule'] as string,
      status: r['status'] as 'open' | 'closed',
      tier: (r['tier'] as Tier | null) ?? null,
      openedAt: (r['opened_at'] as number | null) ?? null,
      openedBlock: (r['opened_block'] as number | null) ?? null,
      lastSeenAt: r['last_seen_at'] as number,
      breachCycles: r['breach_count'] as number,
      breachStartBlock: (r['breach_start_block'] as number | null) ?? null,
      clearCycles: r['clear_count'] as number,
      cooldownUntil: r['cooldown_until'] as number,
      exitBlocking: bool(r['exit_blocking']),
      context: json<AlertContext>((r['payload_json'] as string | null) ?? null),
    };
  }
  get(key: string): ConditionState | undefined {
    const r = this.db.prepare('SELECT * FROM condition WHERE condition_key = ?').get(key) as Record<string, unknown> | undefined;
    return r && this.map(r);
  }
  all(): Map<string, ConditionState> {
    const rows = this.db.prepare('SELECT * FROM condition').all() as Array<Record<string, unknown>>;
    return new Map(rows.map((r) => [r['condition_key'] as string, this.map(r)]));
  }
  listOpen(): ConditionState[] {
    return (this.db.prepare("SELECT * FROM condition WHERE status = 'open' ORDER BY opened_at").all() as Array<Record<string, unknown>>).map((r) =>
      this.map(r),
    );
  }
  upsert(c: ConditionState): void {
    this.db
      .prepare(
        `INSERT INTO condition(condition_key, holding, watcher, rule, status, tier, opened_at, opened_block, last_seen_at,
           breach_count, breach_start_block, clear_count, cooldown_until, exit_blocking, payload_json)
         VALUES (@key, @holding, @watcher, @rule, @status, @tier, @openedAt, @openedBlock, @lastSeenAt,
           @breachCycles, @breachStartBlock, @clearCycles, @cooldownUntil, @exitBlocking, @payload)
         ON CONFLICT(condition_key) DO UPDATE SET
           holding = excluded.holding, watcher = excluded.watcher, rule = excluded.rule, status = excluded.status,
           tier = excluded.tier, opened_at = excluded.opened_at, opened_block = excluded.opened_block,
           last_seen_at = excluded.last_seen_at, breach_count = excluded.breach_count,
           breach_start_block = excluded.breach_start_block, clear_count = excluded.clear_count,
           cooldown_until = excluded.cooldown_until, exit_blocking = excluded.exit_blocking, payload_json = excluded.payload_json`,
      )
      .run({
        key: c.key,
        holding: c.holding,
        watcher: c.watcher,
        rule: c.rule,
        status: c.status,
        tier: c.tier,
        openedAt: c.openedAt,
        openedBlock: c.openedBlock,
        lastSeenAt: c.lastSeenAt,
        breachCycles: c.breachCycles,
        breachStartBlock: c.breachStartBlock,
        clearCycles: c.clearCycles,
        cooldownUntil: c.cooldownUntil,
        exitBlocking: c.exitBlocking ? 1 : 0,
        payload: c.context ? JSON.stringify(c.context) : null,
      });
  }
}

export class AlertRepo {
  constructor(private db: Db) {}

  insert(a: NewAlert): number {
    const r = this.db
      .prepare(
        `INSERT INTO alert(condition_key, tier, holding, kind, is_ops, exposure_usd, exit_path_open, title, message, block, tx_hash,
           fired_at, send_state, next_send_at)
         VALUES (@conditionKey, @tier, @holding, @kind, @isOps, @exposureUsd, @exitPathOpen, @title, @message, @block, @txHash,
           @firedAt, @sendState, 0)`,
      )
      .run({
        ...a,
        isOps: a.isOps ? 1 : 0,
        exitPathOpen: a.exitPathOpen === null ? null : a.exitPathOpen ? 1 : 0,
      });
    return Number(r.lastInsertRowid);
  }

  /** The alert id is only known after insert, so the rendered text is written back. */
  setMessage(id: number, message: string): void {
    this.db.prepare('UPDATE alert SET message = ? WHERE id = ?').run(message, id);
  }

  get(id: number): AlertRow | undefined {
    const r = this.db.prepare('SELECT * FROM alert WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return r && toAlert(r);
  }

  list(): AlertRow[] {
    return (this.db.prepare('SELECT * FROM alert ORDER BY id').all() as Array<Record<string, unknown>>).map(toAlert);
  }

  /** Unresolved alerts for a condition key, newest first. */
  openForKey(key: string): AlertRow[] {
    return (
      this.db.prepare('SELECT * FROM alert WHERE condition_key = ? AND resolved_at IS NULL ORDER BY id DESC').all(key) as Array<
        Record<string, unknown>
      >
    ).map(toAlert);
  }

  /** Alerts waiting for first delivery, oldest first, P0 before the rest. */
  pendingSend(now: number): AlertRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM alert WHERE send_state = 'pending' AND next_send_at <= ?
           ORDER BY CASE tier WHEN 'P0' THEN 0 ELSE 1 END, id`,
        )
        .all(now) as Array<Record<string, unknown>>
    ).map(toAlert);
  }

  /** Resolved alerts whose "RESOLVED" reply has not been delivered yet. */
  pendingResolveNotice(): AlertRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM alert WHERE resolve_notice = 'pending' AND send_state = 'sent' ORDER BY id`)
        .all() as Array<Record<string, unknown>>
    ).map(toAlert);
  }

  /** P0 alerts still live: delivered, not acked, not resolved, not superseded. */
  openP0(): AlertRow[] {
    return (
      this.db
        .prepare(
          `SELECT * FROM alert WHERE tier = 'P0' AND send_state = 'sent' AND resolved_at IS NULL
             AND acked_at IS NULL AND superseded_by IS NULL ORDER BY id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map(toAlert);
  }

  /** Alerts that opened or resolved in (since, until], for the digest. */
  digestSince(since: number): AlertRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM alert WHERE fired_at > ? OR (resolved_at IS NOT NULL AND resolved_at > ?) ORDER BY id`)
        .all(since, since) as Array<Record<string, unknown>>
    ).map(toAlert);
  }

  stillOpen(): AlertRow[] {
    return (
      this.db.prepare('SELECT * FROM alert WHERE resolved_at IS NULL AND superseded_by IS NULL ORDER BY id').all() as Array<
        Record<string, unknown>
      >
    ).map(toAlert);
  }

  markSent(id: number, chat: string, msgId: number, now: number): void {
    this.db
      .prepare(`UPDATE alert SET send_state = 'sent', telegram_chat = ?, telegram_msg_id = ?, last_sent_at = ?, send_attempts = send_attempts + 1 WHERE id = ?`)
      .run(chat, msgId, now, id);
  }

  markSendFailure(id: number, nextSendAt: number, giveUp: boolean): void {
    this.db
      .prepare(`UPDATE alert SET send_attempts = send_attempts + 1, next_send_at = ?, send_state = ? WHERE id = ?`)
      .run(nextSendAt, giveUp ? 'failed' : 'pending', id);
  }

  recordRepeat(id: number, chat: string, msgId: number, now: number): void {
    this.db
      .prepare('UPDATE alert SET repeat_count = repeat_count + 1, telegram_chat = ?, telegram_msg_id = ?, last_sent_at = ? WHERE id = ?')
      .run(chat, msgId, now, id);
  }

  setSnooze(id: number, until: number | null): void {
    this.db.prepare('UPDATE alert SET snoozed_until = ? WHERE id = ?').run(until, id);
  }

  markAcked(id: number, at: number): void {
    this.db.prepare('UPDATE alert SET acked_at = ? WHERE id = ? AND acked_at IS NULL').run(at, id);
  }

  markSuperseded(id: number, byId: number): void {
    this.db.prepare('UPDATE alert SET superseded_by = ? WHERE id = ?').run(byId, id);
  }

  /** Resolve every unresolved alert for the key; the newest one carries the reply notice. */
  resolveKey(key: string, at: number, reason: string): number[] {
    const open = this.openForKey(key);
    open.forEach((a, i) => {
      const notice = i === 0 && (a.sendState === 'sent' || a.sendState === 'pending') ? 'pending' : 'none';
      this.db.prepare('UPDATE alert SET resolved_at = ?, resolve_reason = ?, resolve_notice = ? WHERE id = ?').run(at, reason, notice, a.id);
    });
    return open.map((a) => a.id);
  }

  markResolveNoticeSent(id: number): void {
    this.db.prepare(`UPDATE alert SET resolve_notice = 'sent' WHERE id = ?`).run(id);
  }

  suppressResolveNotice(id: number): void {
    this.db.prepare(`UPDATE alert SET resolve_notice = 'none' WHERE id = ?`).run(id);
  }

  /** P0 repeats sent in the last `windowS` seconds across all alerts (global rate cap). */
  recentRepeatCount(sinceTs: number): number {
    return (this.db.prepare(`SELECT COUNT(*) AS n FROM telegram_message WHERE kind = 'repeat' AND sent_at > ?`).get(sinceTs) as { n: number }).n;
  }
}

export class AckRepo {
  constructor(private db: Db) {}
  insert(alertId: number, userId: number, via: 'button' | 'command', at: number): void {
    this.db.prepare('INSERT INTO ack(alert_id, user_id, via, at) VALUES (?, ?, ?, ?)').run(alertId, userId, via, at);
  }
  forAlert(alertId: number): Array<{ userId: number; via: 'button' | 'command'; at: number }> {
    return (
      this.db.prepare('SELECT user_id, via, at FROM ack WHERE alert_id = ? ORDER BY id').all(alertId) as Array<{
        user_id: number;
        via: 'button' | 'command';
        at: number;
      }>
    ).map((r) => ({ userId: r.user_id, via: r.via, at: r.at }));
  }
}

export class PendingActionRepo {
  constructor(private db: Db) {}
  upsert(p: PendingActionRow): void {
    this.db
      .prepare(
        `INSERT INTO pending_action(id, holding, source, target, selector, decoded_json, eta, status, first_seen_block)
         VALUES (@id, @holding, @source, @target, @selector, @decoded, @eta, @status, @firstSeenBlock)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, eta = excluded.eta, decoded_json = excluded.decoded_json`,
      )
      .run({ ...p, decoded: p.decoded === undefined ? null : JSON.stringify(p.decoded) });
  }
  listQueued(): PendingActionRow[] {
    return (this.db.prepare(`SELECT * FROM pending_action WHERE status = 'queued' ORDER BY eta`).all() as Array<Record<string, unknown>>).map((r) => ({
      id: r['id'] as string,
      holding: r['holding'] as string,
      source: r['source'] as string,
      target: r['target'] as string,
      selector: (r['selector'] as string | null) ?? null,
      decoded: json((r['decoded_json'] as string | null) ?? null),
      eta: (r['eta'] as number | null) ?? null,
      status: r['status'] as PendingActionRow['status'],
      firstSeenBlock: r['first_seen_block'] as number,
    }));
  }
}

export class RpcHealthRepo {
  constructor(private db: Db) {}
  upsert(h: RpcHealthRow): void {
    this.db
      .prepare(
        `INSERT INTO rpc_health(provider, head, lag, errors_1m, ts) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(provider) DO UPDATE SET head = excluded.head, lag = excluded.lag, errors_1m = excluded.errors_1m, ts = excluded.ts`,
      )
      .run(h.provider, h.head, h.lag, h.errors1m, h.ts);
  }
  all(): RpcHealthRow[] {
    return (this.db.prepare('SELECT * FROM rpc_health ORDER BY provider').all() as Array<Record<string, unknown>>).map((r) => ({
      provider: r['provider'] as string,
      head: (r['head'] as number | null) ?? null,
      lag: (r['lag'] as number | null) ?? null,
      errors1m: r['errors_1m'] as number,
      ts: r['ts'] as number,
    }));
  }
}

export class OutboxRepo {
  constructor(private db: Db) {}
  /** Explainer hand-off (v1.1). Phase 0 only provides the table and enqueue. */
  enqueue(alertId: number, now: number): void {
    this.db.prepare(`INSERT OR IGNORE INTO outbox(alert_id, status, created_at) VALUES (?, 'new', ?)`).run(alertId, now);
  }
  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM outbox').get() as { n: number }).n;
  }
}

export class HolderCacheRepo {
  constructor(private db: Db) {}
  replace(asset: string, rows: Array<{ address: string; balance: string }>, ts: number): void {
    this.db.prepare('DELETE FROM holder_cache WHERE asset = ?').run(asset);
    const ins = this.db.prepare('INSERT INTO holder_cache(asset, address, balance, rank, ts) VALUES (?, ?, ?, ?, ?)');
    rows.forEach((r, i) => ins.run(asset, r.address, r.balance, i + 1, ts));
  }
  top(asset: string, n: number): Array<{ address: string; balance: string; rank: number }> {
    return this.db.prepare('SELECT address, balance, rank FROM holder_cache WHERE asset = ? ORDER BY rank LIMIT ?').all(asset, n) as Array<{
      address: string;
      balance: string;
      rank: number;
    }>;
  }
}

export class TelegramMessageRepo {
  constructor(private db: Db) {}
  insert(m: Omit<TelegramMessageRow, 'id' | 'live'>): void {
    this.db
      .prepare('INSERT INTO telegram_message(alert_id, bot, chat_id, message_id, kind, live, sent_at) VALUES (?, ?, ?, ?, ?, 1, ?)')
      .run(m.alertId, m.bot, m.chatId, m.messageId, m.kind, m.sentAt);
  }
  liveForAlert(alertId: number): TelegramMessageRow[] {
    return (
      this.db.prepare('SELECT * FROM telegram_message WHERE alert_id = ? AND live = 1 ORDER BY id').all(alertId) as Array<Record<string, unknown>>
    ).map((r) => ({
      id: r['id'] as number,
      alertId: r['alert_id'] as number,
      bot: r['bot'] as 'p0' | 'p1' | 'p2',
      chatId: r['chat_id'] as string,
      messageId: r['message_id'] as number,
      kind: r['kind'] as 'open' | 'repeat' | 'resolved',
      live: bool(r['live']),
      sentAt: r['sent_at'] as number,
    }));
  }
  retire(id: number): void {
    this.db.prepare('UPDATE telegram_message SET live = 0 WHERE id = ?').run(id);
  }
}

export class KvRepo {
  constructor(private db: Db) {}
  get(key: string): string | undefined {
    return (this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined)?.value;
  }
  set(key: string, value: string, now: number): void {
    this.db
      .prepare('INSERT INTO kv(key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
      .run(key, value, now);
  }
}
