import { describe, expect, it } from 'vitest';
import { AlertDelivery } from '../src/telegram/delivery.js';
import { TelegramError } from '../src/telegram/api.js';
import { CHATS, EXPLORER, T0, makeEnv, newAlert } from './telegram-helpers.js';
import type { Env } from './telegram-helpers.js';

function setup(over: Parameters<typeof makeEnv>[0] = {}): { env: Env; d: AlertDelivery } {
  const env = makeEnv(over);
  const d = new AlertDelivery({ store: env.store, gateway: env.gw, config: env.config, explorer: EXPLORER, clock: env.clock, log: env.log });
  return { env, d };
}

describe('first delivery', () => {
  it('sends P0 on the P0 bot with ACK/Snooze keyboard and records the message', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert());
    expect(await d.deliverPending()).toBe(1);

    const sent = env.gw.p0.sent;
    expect(sent).toHaveLength(1);
    expect(sent[0]?.chatId).toBe(String(CHATS.p0));
    expect(sent[0]?.opts.keyboard).toEqual([
      [{ text: '✅ ACK', callbackData: `ack:${id}` }],
      [{ text: '😴 Snooze 1h', callbackData: `snooze:${id}` }],
    ]);
    const row = env.store.repos.alert.get(id);
    expect(row).toMatchObject({ sendState: 'sent', telegramMsgId: 1, lastSentAt: T0 });
    expect(env.store.repos.telegramMessage.liveForAlert(id)).toMatchObject([{ bot: 'p0', messageId: 1, kind: 'open' }]);
  });

  it('sends the stored HTML verbatim and fills the alert id marker', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert({ message: '<b>X</b> &amp; y\nalert #? · <code>k</code>' }));
    await d.deliverPending();
    expect(env.gw.p0.sent[0]?.text).toBe(`<b>X</b> &amp; y\nalert #${id} · <code>k</code>`);
  });

  it('renders a minimal message when the column is empty', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert({ message: '', txHash: null }));
    await d.deliverPending();
    const text = env.gw.p0.sent[0]?.text ?? '';
    expect(text).toContain('Exit path:');
    expect(text).toContain(`alert #${id}`);
  });

  it('sends P1 (and OPS P1) plain on the P1 bot, never on P0', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert({ tier: 'P1' }));
    env.store.repos.alert.insert(newAlert({ tier: 'P1', isOps: true, conditionKey: 'ops/rpc_lag' }));
    await d.deliverPending();
    expect(env.gw.p1.sent).toHaveLength(2);
    expect(env.gw.p1.sent[0]?.opts.keyboard).toBeUndefined();
    expect(env.gw.p0.sent).toHaveLength(0);
    expect(env.gw.p1.sent[0]?.chatId).toBe(String(CHATS.p1));
  });

  it('never sends P2 immediately, whether digest or (wrongly) pending', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert({ tier: 'P2', sendState: 'digest' }));
    env.store.repos.alert.insert(newAlert({ tier: 'P2', sendState: 'pending', conditionKey: 'x/y' }));
    await d.tick();
    for (const bot of ['p0', 'p1', 'p2'] as const) expect(env.gw[bot].sent).toHaveLength(0);
  });

  it('delivers P0 before P1', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert({ tier: 'P1', conditionKey: 'a' }));
    env.store.repos.alert.insert(newAlert({ tier: 'P0', conditionKey: 'b' }));
    await d.deliverPending();
    expect(env.gw.p0.sent[0]?.seq).toBeLessThan(env.gw.p1.sent[0]?.seq ?? 0);
  });

  it('falls back to plain text when Telegram rejects the HTML', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert({ message: '<b>unclosed alert #?' }));
    env.gw.p0.failNext(1, new TelegramError({ method: 'sendMessage', status: 400, errorCode: 400, description: "Bad Request: can't parse entities" }));
    await d.deliverPending();
    expect(env.gw.p0.sent).toHaveLength(1);
    expect(env.gw.p0.sent[0]?.opts.plain).toBe(true);
    expect(env.gw.p0.sent[0]?.text).not.toContain('<b>');
  });
});

describe('P0 repeat loop', () => {
  async function firstP0(over: Parameters<typeof makeEnv>[0] = {}): Promise<{ env: Env; d: AlertDelivery; id: number }> {
    const { env, d } = setup(over);
    const id = env.store.repos.alert.insert(newAlert());
    await d.tick();
    return { env, d, id };
  }

  it('repeats every 5 minutes until ACK, superseding the previous message each time', async () => {
    const { env, d, id } = await firstP0();
    env.clock.advance(299);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1); // not yet

    env.clock.advance(1);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);
    const rep = env.gw.p0.sent[1];
    expect(rep?.text.startsWith('🔁 <b>repeat #1</b> — unacknowledged since 5m\n')).toBe(true);
    expect(rep?.opts.keyboard?.[0]?.[0]?.callbackData).toBe(`ack:${id}`);
    // old message edited to superseded, keyboard removed, then retired
    expect(env.gw.p0.edits).toHaveLength(1);
    expect(env.gw.p0.edits[0]).toMatchObject({ messageId: 1, keyboard: null });
    expect(env.gw.p0.edits[0]?.text).toContain('Superseded');
    expect(env.store.repos.telegramMessage.liveForAlert(id).map((m) => m.messageId)).toEqual([2]);

    env.clock.advance(300);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(3);
    expect(env.gw.p0.sent[2]?.text).toContain('repeat #2');
    expect(env.gw.p0.edits.map((e) => e.messageId)).toEqual([1, 2]);
    expect(env.store.repos.alert.get(id)).toMatchObject({ repeatCount: 2, telegramMsgId: 3 });
    expect(env.store.repos.telegramMessage.liveForAlert(id).map((m) => m.messageId)).toEqual([3]);
  });

  it('ACK stops repeats', async () => {
    const { env, d, id } = await firstP0();
    env.store.repos.alert.markAcked(id, env.clock.now());
    env.clock.advance(3600);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('stops repeating after the 24h cap but keeps the alert open', async () => {
    const { env, d, id } = await firstP0();
    let n = 0;
    while (env.clock.now() < T0 + 24 * 3600 + 3600) {
      env.clock.advance(300);
      await d.tick();
      if (++n > 400) throw new Error('runaway');
    }
    const sent = env.gw.p0.sent.length;
    // firedAt + 24h is the last moment a repeat may go out (exclusive): 1 open + repeats up to < 24h
    expect(sent).toBeLessThanOrEqual(1 + 24 * 12);
    expect(sent).toBeGreaterThan(24 * 12 - 2);
    const lastSent = env.store.repos.alert.get(id)?.lastSentAt ?? 0;
    expect(lastSent).toBeLessThan(T0 + 24 * 3600);
    env.clock.advance(3600);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(sent);
    expect(env.store.repos.alert.get(id)?.resolvedAt).toBeNull();
  });

  it('honours the cap boundary exactly', async () => {
    const { env, d } = await firstP0({ repeat_cap_hours: 1 });
    env.clock.t = T0 + 3600; // firedAt + cap <= now
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('enforces one repeat per global interval across simultaneous P0s', async () => {
    const { env, d } = setup();
    const a = env.store.repos.alert.insert(newAlert({ conditionKey: 'a/1' }));
    const b = env.store.repos.alert.insert(newAlert({ conditionKey: 'b/1' }));
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);

    env.clock.advance(300);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(3); // only one repeat in this minute
    expect(env.store.repos.alert.get(a)?.repeatCount).toBe(1);
    expect(env.store.repos.alert.get(b)?.repeatCount).toBe(0);

    env.clock.advance(59);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(3);

    env.clock.advance(1);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(4);
    expect(env.store.repos.alert.get(b)?.repeatCount).toBe(1);
  });

  it('snooze suppresses repeats, then they resume', async () => {
    const { env, d, id } = await firstP0();
    env.store.repos.alert.setSnooze(id, env.clock.now() + 3600);
    for (let i = 0; i < 11; i++) {
      env.clock.advance(300);
      await d.tick();
    }
    expect(env.gw.p0.sent).toHaveLength(1); // 55 min in, still snoozed
    env.clock.advance(300 + 1); // past the snooze end
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);
    expect(env.gw.p0.sent[1]?.text).toContain('repeat #1');
  });

  it('a failed edit of the old message never fails the repeat', async () => {
    const { env, d, id } = await firstP0();
    env.clock.advance(300);
    // the repeat send succeeds, the following edit is the failing call
    const orig = env.gw.p0.sendMessage.bind(env.gw.p0);
    env.gw.p0.sendMessage = async (...args: Parameters<typeof orig>) => {
      const r = await orig(...args);
      env.gw.p0.failNext(1);
      return r;
    };
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);
    expect(env.store.repos.alert.get(id)?.repeatCount).toBe(1);
    // old message stays live so the next repeat retries the edit
    expect(env.store.repos.telegramMessage.liveForAlert(id).map((m) => m.messageId)).toEqual([1, 2]);
    env.gw.p0.sendMessage = orig;
    env.clock.advance(300);
    await d.tick();
    expect(env.store.repos.telegramMessage.liveForAlert(id).map((m) => m.messageId)).toEqual([3]);
  });

  it('a failed repeat send is retried and the old message keeps its buttons', async () => {
    const { env, d, id } = await firstP0();
    env.clock.advance(300);
    env.gw.p0.failNext(1);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
    expect(env.gw.p0.edits).toHaveLength(0);
    expect(env.store.repos.telegramMessage.liveForAlert(id)).toHaveLength(1);
    env.clock.advance(10);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);
  });
});

describe('never lose a P0', () => {
  it('keeps retrying through N simulated 5xx failures with capped backoff, then delivers', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert());
    env.gw.p0.failNext(30);
    let ticks = 0;
    while (env.gw.p0.sent.length === 0) {
      await d.tick();
      env.clock.advance(1);
      if (++ticks > 20_000) throw new Error('never delivered');
    }
    expect(env.gw.p0.failedCalls).toBe(30);
    const row = env.store.repos.alert.get(id);
    expect(row?.sendState).toBe('sent');
    expect(row?.sendAttempts).toBe(31);
    // backoff capped at 5 minutes: 30 failures cannot take more than 30 * 300s
    expect(env.clock.now() - T0).toBeLessThanOrEqual(30 * 300);
  });

  it('applies exponential backoff and never marks a P0 failed', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert());
    env.gw.p0.failNext(100);
    const delays: number[] = [];
    for (let i = 0; i < 25; i++) {
      await d.deliverPending();
      const r = env.store.repos.alert.get(id);
      expect(r?.sendState).toBe('pending');
      delays.push((r?.nextSendAt ?? 0) - env.clock.now());
      env.clock.t = r?.nextSendAt ?? env.clock.t;
    }
    expect(delays.slice(0, 4)).toEqual([5, 10, 20, 40]);
    expect(Math.max(...delays)).toBe(300);
    expect(delays[24]).toBe(300);
  });

  it('is not re-attempted before its backoff expires', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert());
    env.gw.p0.failNext(1);
    await d.tick();
    expect(env.gw.p0.failedCalls).toBe(1);
    await d.tick(); // same instant: next_send_at is in the future
    expect(env.gw.p0.sent).toHaveLength(0);
    env.clock.advance(5);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('honours Retry-After from a 429', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert());
    env.gw.p0.failNext(1, new TelegramError({ method: 'sendMessage', status: 429, errorCode: 429, description: 'Too Many Requests', retryAfter: 90 }));
    await d.deliverPending();
    expect((env.store.repos.alert.get(id)?.nextSendAt ?? 0) - T0).toBe(90);
  });

  it('P1 gives up after ~20 attempts and is marked failed', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert({ tier: 'P1' }));
    env.gw.p1.failNext(100);
    for (let i = 0; i < 40; i++) {
      await d.deliverPending();
      env.clock.advance(400);
    }
    const row = env.store.repos.alert.get(id);
    expect(row?.sendState).toBe('failed');
    expect(row?.sendAttempts).toBe(20);
    expect(env.gw.p1.failedCalls).toBe(20);
  });

  it('tick never throws even when the store call blows up', async () => {
    const { env, d } = setup();
    env.store.repos.alert.pendingSend = () => {
      throw new Error('db down');
    };
    await expect(d.tick()).resolves.toBeUndefined();
  });
});

describe('resolved notices', () => {
  it('replies to the alert message for P1 and posts nothing on the other bots', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert({ tier: 'P1' }));
    await d.tick();
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', env.clock.now(), 'slot restored');
    await d.tick();
    const msgs = env.gw.p1.sent;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]?.opts.replyToMessageId).toBe(1);
    expect(msgs[1]?.text).toContain('RESOLVED');
    expect(msgs[1]?.text).toContain('slot restored');
    expect(env.store.repos.alert.get(id)?.resolveNotice).toBe('sent');
    expect(env.gw.p1.edits).toHaveLength(0);
    await d.tick();
    expect(env.gw.p1.sent).toHaveLength(2); // exactly once
  });

  it('replies on the P0 bot, strips the live keyboard and appends RESOLVED for P0', async () => {
    const { env, d, } = setup();
    const id = env.store.repos.alert.insert(newAlert());
    await d.tick();
    env.clock.advance(300);
    await d.tick(); // one repeat -> latest message id 2
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', env.clock.now(), 'slot restored');
    await d.tick();
    const reply = env.gw.p0.sent[2];
    expect(reply?.opts.replyToMessageId).toBe(2);
    expect(reply?.text).toContain('RESOLVED');
    const lastEdit = env.gw.p0.edits[env.gw.p0.edits.length - 1];
    expect(lastEdit).toMatchObject({ messageId: 2, keyboard: null });
    expect(lastEdit?.text).toContain('RESOLVED');
    expect(env.store.repos.telegramMessage.liveForAlert(id)).toHaveLength(0);
    expect(env.store.repos.alert.get(id)?.resolveNotice).toBe('sent');
  });

  it('stops repeats once resolved', async () => {
    const { env, d } = setup();
    env.store.repos.alert.insert(newAlert());
    await d.tick();
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', env.clock.now(), 'ok');
    env.clock.advance(3000);
    await d.tick();
    expect(env.gw.p0.sent.filter((s) => s.text.includes('repeat'))).toHaveLength(0);
  });

  it('gives superseded alerts no notice', async () => {
    const { env, d } = setup();
    const a = env.store.repos.alert.insert(newAlert({ tier: 'P1' }));
    await d.tick();
    const b = env.store.repos.alert.insert(newAlert({ tier: 'P0', kind: 'escalation' }));
    env.store.repos.alert.markSuperseded(a, b);
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', env.clock.now(), 'done');
    // resolveKey notices only the newest (b); force the superseded one too, as a worst case
    env.store.db.prepare(`UPDATE alert SET resolve_notice = 'pending' WHERE id = ?`).run(a);
    await d.tick();
    expect(env.store.repos.alert.get(a)?.resolveNotice).toBe('none');
    expect(env.gw.p1.sent.filter((s) => s.text.includes('RESOLVED'))).toHaveLength(0);
    expect(env.gw.p0.sent.filter((s) => s.text.includes('RESOLVED'))).toHaveLength(1);
  });

  it('retries a failed notice later and keeps it pending meanwhile', async () => {
    const { env, d } = setup();
    const id = env.store.repos.alert.insert(newAlert({ tier: 'P1' }));
    await d.tick();
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', env.clock.now(), 'ok');
    env.gw.p1.failNext(1);
    await d.tick();
    expect(env.store.repos.alert.get(id)?.resolveNotice).toBe('pending');
    env.clock.advance(5);
    await d.tick();
    expect(env.store.repos.alert.get(id)?.resolveNotice).toBe('sent');
  });
});
