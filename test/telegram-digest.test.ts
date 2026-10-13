import { describe, expect, it } from 'vitest';
import { DigestJob, KV_LAST_DATE, KV_LAST_SENT_AT } from '../src/telegram/digest.js';
import type { ConditionState } from '../src/rules/types.js';
import { CHATS, insertAlert, makeEnv, newAlert, statusSnapshot } from './telegram-helpers.js';
import type { Env } from './telegram-helpers.js';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number => Math.floor(Date.UTC(y, mo - 1, d, h, mi, s) / 1000);

function job(env: Env): DigestJob {
  return new DigestJob({ store: env.store, gateway: env.gw, config: env.config, status: env.status, clock: env.clock, log: env.log });
}

function envAt(t: number, tz: string, time = '09:00'): Env {
  const env = makeEnv({ digest: { time, timezone: tz } }, t);
  env.status.snap = statusSnapshot({ now: t, lastHealthcheckPingAt: t - 45 });
  return env;
}

const texts = (env: Env): string[] => env.gw.p2.sent.map((s) => s.text);

describe('digest schedule', () => {
  it('sends at 09:00 UTC, once per day, to the P2 chat only', async () => {
    const env = envAt(utc(2026, 10, 13, 8, 59, 59), 'UTC');
    const j = job(env);
    expect(await j.tick()).toBe(false);
    expect(env.gw.p2.sent).toHaveLength(0);
    env.clock.t = utc(2026, 10, 13, 9, 0, 0);
    expect(await j.tick()).toBe(true);
    expect(env.gw.p2.sent).toHaveLength(1);
    expect(env.gw.p2.sent[0]?.chatId).toBe(String(CHATS.p2));
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBe('2026-10-13');
    expect(env.store.repos.kv.get(KV_LAST_SENT_AT)).toBe(String(utc(2026, 10, 13, 9, 0, 0)));
    env.clock.t = utc(2026, 10, 13, 23, 59, 0);
    expect(await j.tick()).toBe(false);
    expect(env.gw.p2.sent).toHaveLength(1);
    expect(env.gw.p0.sent).toHaveLength(0);
    expect(env.gw.p1.sent).toHaveLength(0);
    env.clock.t = utc(2026, 10, 14, 9, 0, 0);
    expect(await j.tick()).toBe(true);
    expect(env.gw.p2.sent).toHaveLength(2);
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBe('2026-10-14');
  });

  it('09:00 America/New_York is 13:00 UTC in EDT and 14:00 UTC in EST, not 09:00 UTC', async () => {
    const env = envAt(utc(2026, 10, 13, 9, 0, 0), 'America/New_York');
    const j = job(env);
    expect(await j.tick()).toBe(false); // 05:00 in New York
    env.clock.t = utc(2026, 10, 13, 12, 59, 59);
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 10, 13, 13, 0, 0);
    expect(await j.tick()).toBe(true);
    expect(texts(env)[0]).toContain('2026-10-13');

    const winter = envAt(utc(2026, 12, 15, 13, 59, 59), 'America/New_York');
    const jw = job(winter);
    expect(await jw.tick()).toBe(false); // 08:59 EST
    winter.clock.t = utc(2026, 12, 15, 14, 0, 0);
    expect(await jw.tick()).toBe(true);
  });

  it('the local date, not the UTC date, decides "today" (no re-send when UTC rolls over mid-evening)', async () => {
    const env = envAt(utc(2026, 10, 13, 13, 0, 0), 'America/New_York');
    const j = job(env);
    expect(await j.tick()).toBe(true);
    env.clock.t = utc(2026, 10, 14, 3, 30, 0); // 23:30 on Oct 13 in New York, already Oct 14 in UTC
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 10, 14, 12, 59, 0); // 08:59 Oct 14 local
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 10, 14, 13, 0, 0);
    expect(await j.tick()).toBe(true);
    expect(env.gw.p2.sent).toHaveLength(2);
  });

  it('is correct on the spring-forward day (2026-03-08, New York)', async () => {
    const env = envAt(utc(2026, 3, 8, 12, 59, 0), 'America/New_York'); // 08:59 EDT
    const j = job(env);
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 3, 8, 13, 0, 0); // 09:00 EDT
    expect(await j.tick()).toBe(true);
    // the day before is still EST: 09:00 EST = 14:00 UTC
    const prev = envAt(utc(2026, 3, 7, 13, 59, 0), 'America/New_York');
    expect(await job(prev).tick()).toBe(false);
    prev.clock.t = utc(2026, 3, 7, 14, 0, 0);
    expect(await job(prev).tick()).toBe(true);
  });

  it('is correct on the fall-back day (2026-11-01, New York) and does not double-send in the repeated hour', async () => {
    const env = envAt(utc(2026, 11, 1, 13, 59, 0), 'America/New_York'); // 08:59 EST (09:00 EDT would be 13:00Z)
    const j = job(env);
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 11, 1, 14, 0, 0);
    expect(await j.tick()).toBe(true);
    env.clock.t = utc(2026, 11, 1, 15, 0, 0);
    expect(await j.tick()).toBe(false);
    // an early-morning slot that happens twice locally still sends once
    const dup = envAt(utc(2026, 11, 1, 5, 30, 0), 'America/New_York', '01:30'); // 01:30 EDT, first pass
    const jd = job(dup);
    expect(await jd.tick()).toBe(true);
    dup.clock.t = utc(2026, 11, 1, 6, 30, 0); // 01:30 EST, second pass
    expect(await jd.tick()).toBe(false);
  });

  it('a configured time that does not exist on the spring-forward day sends once the clock passes it', async () => {
    const env = envAt(utc(2026, 3, 8, 6, 59, 0), 'America/New_York', '02:30'); // 01:59 EST
    const j = job(env);
    expect(await j.tick()).toBe(false);
    env.clock.t = utc(2026, 3, 8, 7, 0, 0); // 03:00 EDT
    expect(await j.tick()).toBe(true);
  });

  it('a restart after 09:00 still sends once, and a second restart does not double-send', async () => {
    const env = envAt(utc(2026, 10, 13, 15, 42, 0), 'UTC');
    expect(await job(env).tick()).toBe(true); // fresh process after 09:00
    expect(await job(env).tick()).toBe(false); // another restart the same day
    expect(env.gw.p2.sent).toHaveLength(1);
    env.clock.t = utc(2026, 10, 14, 7, 0, 0);
    expect(await job(env).tick()).toBe(false); // next day, before 09:00
    env.clock.t = utc(2026, 10, 14, 9, 5, 0);
    expect(await job(env).tick()).toBe(true);
  });

  it("supports timezone 'local' (host zone) without throwing", async () => {
    const env = envAt(utc(2026, 10, 13, 12, 0, 0), 'local', '00:00');
    expect(await job(env).tick()).toBe(true);
  });

  it('does not record success when sending fails; retries after a pause and then records once', async () => {
    const env = envAt(utc(2026, 10, 13, 9, 0, 0), 'UTC');
    const j = job(env);
    env.gw.p2.failNext(1);
    expect(await j.tick()).toBe(false);
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBeUndefined();
    expect(await j.tick()).toBe(false); // inside the retry pause
    env.clock.advance(61);
    expect(await j.tick()).toBe(true);
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBe('2026-10-13');
    expect(env.gw.p2.sent).toHaveLength(1);
  });

  it('never throws', async () => {
    const env = envAt(utc(2026, 10, 13, 9, 0, 0), 'UTC');
    env.status.snapshot = () => {
      throw new Error('status down');
    };
    await expect(job(env).tick()).resolves.toBe(false);
  });
});

function cond(key: string, holding: string, tier: 'P0' | 'P1', openedAt: number): ConditionState {
  return {
    key,
    holding,
    watcher: 'w',
    rule: 'r',
    status: 'open',
    tier,
    openedAt,
    openedBlock: 1,
    lastSeenAt: openedAt,
    breachCycles: 1,
    breachStartBlock: 1,
    clearCycles: 0,
    cooldownUntil: 0,
    exitBlocking: false,
    context: { title: `title of ${key}` },
  };
}

describe('digest content', () => {
  it('contains the alive line, still-open P0/P1 first, per-holding sections, P2 since last digest, closed, and OPS health', async () => {
    const t1 = utc(2026, 10, 13, 9, 0, 0);
    const env = envAt(t1, 'UTC');
    const r = env.store.repos;
    const p0 = insertAlert(env.store, { tier: 'P0', title: 'Impl slot <changed>', firedAt: t1 - 7200, sendState: 'sent' });
    insertAlert(env.store, { tier: 'P1', conditionKey: 'ousg/rwa/nav', holding: 'ousg', title: 'NAV stale', firedAt: t1 - 3600, sendState: 'sent' });
    r.alert.insert(newAlert({ tier: 'P2', conditionKey: 'steakhouse-usdc/flows/tvl', title: 'TVL down 15% in 7d', firedAt: t1 - 1800, sendState: 'digest' }));
    insertAlert(env.store, { tier: 'P1', isOps: true, holding: 'ops', conditionKey: 'ops/rpc_lag', title: 'RPC lag', firedAt: t1 - 600, sendState: 'sent' });
    r.condition.upsert(cond('steakhouse-usdc/proxy/impl-slot', 'steakhouse-usdc', 'P0', t1 - 7200));
    r.condition.upsert(cond('ousg/rwa/nav', 'ousg', 'P1', t1 - 3600));

    expect(await job(env).tick()).toBe(true);
    const t = texts(env).join('\n');
    expect(t).toContain('Sentinel daily digest</b> — 2026-10-13');
    expect(t).toContain('✅ <b>Sentinel alive</b> — head 21,000,000, processed 20,999,998, uptime 3d 4h, 7100 cycles/24h, rpc OK');
    expect(t).toContain('last Healthchecks ping 45s ago');
    expect(t).toContain('watcher errors 1');
    // order: alive < still open < holdings < ops
    const iAlive = t.indexOf('Sentinel alive');
    const iOpen = t.indexOf('Still open');
    const iHolding = t.indexOf('📦');
    const iOps = t.indexOf('OPS / watcher health');
    expect(iAlive).toBeLessThan(iOpen);
    expect(iOpen).toBeLessThan(iHolding);
    expect(iHolding).toBeLessThan(iOps);
    const stillOpen = t.slice(iOpen, iHolding);
    expect(stillOpen).toContain(`P0 #${p0}`);
    expect(stillOpen).toContain('Impl slot &lt;changed&gt;');
    expect(stillOpen).toContain('UNACKED');
    expect(stillOpen).toContain('NAV stale');
    expect(stillOpen).not.toContain('TVL down'); // P2 is not a "still open P1/P0"
    // per-holding
    expect(t).toContain('📦 <b>steakhouse-usdc</b>');
    expect(t).toContain('steakhouse-usdc</code>: $123,456.78 — exit path OPEN');
    expect(t).toContain('📦 <b>ousg</b>');
    expect(t).toContain('ousg</code>: unknown — exit path CLOSED (redemption paused)');
    expect(t).toContain('🟡 P2 opened: TVL down 15% in 7d');
    expect(t).toContain('open: P0 <code>steakhouse-usdc/proxy/impl-slot</code>');
    // ops
    expect(t.slice(iOps)).toContain('OPS P1: RPC lag — STILL OPEN');
    expect(t.slice(iOps)).toContain('rwa</b>: 3 consecutive errors');
    expect(t).not.toContain('📦 <b>ops</b>');
  });

  it('second digest lists only P2 opened since the previous one, and what closed since', async () => {
    const t1 = utc(2026, 10, 13, 9, 0, 0);
    const env = envAt(t1, 'UTC');
    const r = env.store.repos;
    r.alert.insert(newAlert({ tier: 'P2', conditionKey: 'a/old', title: 'OLD P2', firedAt: t1 - 3600, sendState: 'digest' }));
    insertAlert(env.store, { tier: 'P1', conditionKey: 'a/closing', title: 'WILL CLOSE', firedAt: t1 - 3600, sendState: 'sent' });
    expect(await job(env).tick()).toBe(true);
    expect(texts(env).join('\n')).toContain('OLD P2');

    r.alert.insert(newAlert({ tier: 'P2', conditionKey: 'a/new', title: 'NEW P2', firedAt: t1 + 5 * 3600, sendState: 'digest' }));
    r.alert.resolveKey('a/closing', t1 + 6 * 3600, 'peg recovered');
    env.clock.t = utc(2026, 10, 14, 9, 0, 0);
    env.status.snap = statusSnapshot({ now: env.clock.t });
    expect(await job(env).tick()).toBe(true);
    const second = env.gw.p2.sent.at(-1)?.text ?? '';
    expect(second).toContain('NEW P2');
    expect(second).not.toContain('OLD P2');
    expect(second).toContain('✔ closed: WILL CLOSE — peg recovered');
    expect(second).not.toMatch(/Still open[\s\S]*WILL CLOSE[\s\S]*📦/);
  });

  it('says so explicitly when nothing is open', async () => {
    const env = envAt(utc(2026, 10, 13, 9, 0, 0), 'UTC');
    env.status.snap = statusSnapshot({ holdings: [], watchers: [] });
    await job(env).tick();
    const t = texts(env).join('\n');
    expect(t).toContain('• none');
    expect(t).toContain('No holdings configured');
    expect(t).toContain('no OPS alerts since the previous digest');
  });
});

describe('digest splitting', () => {
  function bigEnv(): Env {
    const t1 = utc(2026, 10, 13, 9, 0, 0);
    const env = envAt(t1, 'UTC');
    const holdings = Array.from({ length: 60 }, (_, i) => ({
      id: `holding-${String(i).padStart(2, '0')}`,
      exposureUsd: 1000 * i,
      exitPathOpen: true,
      exitPathReason: 'ok & <fine>',
      watchers: ['w'],
    }));
    env.status.snap = statusSnapshot({ now: t1, holdings });
    for (let i = 0; i < 60; i++) {
      env.store.repos.alert.insert(
        newAlert({ tier: 'P2', conditionKey: `holding-${String(i).padStart(2, '0')}/x`, holding: `holding-${String(i).padStart(2, '0')}`, title: 'P2 & more '.repeat(8), firedAt: t1 - 100, sendState: 'digest' }),
      );
    }
    return env;
  }

  it('splits into messages of at most 4000 chars on line boundaries, losing nothing', async () => {
    const env = bigEnv();
    expect(await job(env).tick()).toBe(true);
    const parts = texts(env);
    expect(parts.length).toBeGreaterThan(1);
    for (const p of parts) expect(p.length).toBeLessThanOrEqual(4000);
    const joined = parts.join('\n');
    for (let i = 0; i < 60; i++) expect(joined).toContain(`📦 <b>holding-${String(i).padStart(2, '0')}</b>`);
    // every chunk keeps balanced tags (no tag spans a line)
    for (const p of parts) {
      expect((p.match(/<b>/g) ?? []).length).toBe((p.match(/<\/b>/g) ?? []).length);
      expect((p.match(/<code>/g) ?? []).length).toBe((p.match(/<\/code>/g) ?? []).length);
    }
  });

  it('resumes a partly delivered digest without re-sending the chunks already out', async () => {
    const env = bigEnv();
    const j = job(env);
    const orig = env.gw.p2.sendMessage.bind(env.gw.p2);
    let n = 0;
    env.gw.p2.sendMessage = (...a: Parameters<typeof orig>) => (++n === 2 ? Promise.reject(new Error('5xx')) : orig(...a));
    expect(await j.tick()).toBe(false);
    expect(env.gw.p2.sent).toHaveLength(1);
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBeUndefined();
    env.clock.advance(61);
    expect(await j.tick()).toBe(true);
    const parts = texts(env);
    expect(new Set(parts).size).toBe(parts.length); // no duplicate chunk
    expect(env.store.repos.kv.get(KV_LAST_DATE)).toBe('2026-10-13');
  });
});
