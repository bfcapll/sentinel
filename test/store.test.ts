import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATIONS } from '../src/store/migrations.js';
import { Store, migrate, openDb } from '../src/store/db.js';

const TABLES = [
  'cursor', 'block_log', 'snapshot', 'snapshot_history', 'observation', 'condition', 'alert', 'ack',
  'pending_action', 'rpc_health', 'outbox', 'holder_cache', 'telegram_message', 'kv',
];

describe('store', () => {
  it('creates every PLAN.md §4 table and is idempotent', () => {
    const db = openDb(':memory:');
    expect(migrate(db)).toBe(MIGRATIONS.length);
    expect(migrate(db)).toBe(0);
    const names = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>).map((r) => r.name);
    for (const t of TABLES) expect(names).toContain(t);
  });

  it('uses WAL mode on a file database', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'sentinel-')), 'data', 's.db');
    const s = Store.open(file);
    expect(s.db.pragma('journal_mode', { simple: true })).toBe('wal');
    s.close();
  });

  it('rolls back the whole transaction (cursor included) when anything throws', () => {
    const s = Store.open(':memory:');
    s.repos.cursor.set('ethereum', 1, '0x01', 1);
    expect(() =>
      s.tx(() => {
        s.repos.cursor.set('ethereum', 2, '0x02', 2);
        s.repos.kv.set('a', 'b', 2);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(s.repos.cursor.get('ethereum')?.block).toBe(1);
    expect(s.repos.kv.get('a')).toBeUndefined();
  });

  it('nested tx joins the outer transaction', () => {
    const s = Store.open(':memory:');
    expect(() =>
      s.tx(() => {
        s.tx(() => s.repos.kv.set('x', '1', 1));
        throw new Error('outer');
      }),
    ).toThrow('outer');
    expect(s.repos.kv.get('x')).toBeUndefined();
  });

  it('block_log keeps only the newest 64 rows', () => {
    const s = Store.open(':memory:');
    for (let i = 1; i <= 100; i++) s.repos.blockLog.put(i, `0x${i}`, `0x${i - 1}`);
    s.repos.blockLog.prune(64);
    expect(s.repos.blockLog.get(36)).toBeUndefined();
    expect(s.repos.blockLog.get(37)).toBeDefined();
    expect(s.repos.blockLog.count()).toBe(64);
    s.repos.blockLog.deleteAbove(90);
    expect(s.repos.blockLog.get(91)).toBeUndefined();
  });

  it('snapshot round-trips values (bigint as string), by prefix, with history', () => {
    const s = Store.open(':memory:');
    s.repos.snapshot.put('h/w/a', { v: 1n }, 5, 50);
    s.repos.snapshot.put('h/w/b', 'x', 5, 50);
    s.repos.snapshot.put('other/a', 1, 5, 50);
    expect(s.repos.snapshot.get('h/w/a')?.value).toEqual({ v: '1' });
    expect([...s.repos.snapshot.byPrefix('h/w/').keys()].sort()).toEqual(['h/w/a', 'h/w/b']);
    s.repos.snapshot.addHistory('h/n', 1, 1, 100);
    s.repos.snapshot.addHistory('h/n', 2, 2, 200);
    expect(s.repos.snapshot.history('h/n', 150)).toEqual([{ value: 2, block: 2, ts: 200 }]);
    expect(s.repos.snapshot.pruneHistory(150)).toBe(1);
  });

  it('alert lifecycle: insert, send, supersede, resolve notice goes to the newest only', () => {
    const s = Store.open(':memory:');
    const a = s.repos.alert;
    const base = { conditionKey: 'k', holding: 'h', kind: 'open' as const, isOps: false, exposureUsd: null, exitPathOpen: true, title: 't', message: 'm', block: 1, txHash: null, firedAt: 10, sendState: 'pending' as const };
    const id1 = a.insert({ ...base, tier: 'P1' });
    a.markSent(id1, 'chat', 7, 11);
    const id2 = a.insert({ ...base, tier: 'P0', kind: 'escalation' });
    a.markSuperseded(id1, id2);
    a.markSent(id2, 'chat', 8, 12);
    expect(a.openP0().map((r) => r.id)).toEqual([id2]);
    a.resolveKey('k', 20, 'cleared');
    expect(a.get(id1)?.resolveNotice).toBe('none');
    expect(a.get(id2)?.resolveNotice).toBe('pending');
    expect(a.pendingResolveNotice().map((r) => r.id)).toEqual([id2]);
  });
});
