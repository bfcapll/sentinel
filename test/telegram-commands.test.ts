import { describe, expect, it } from 'vitest';
import { AlertDelivery } from '../src/telegram/delivery.js';
import { UpdateHandler } from '../src/telegram/commands.js';
import type { BotName, TgUpdate } from '../src/telegram/api.js';
import type { ConditionState } from '../src/rules/types.js';
import { CHATS, EXPLORER, OWNER, T0, makeEnv, newAlert, statusSnapshot } from './telegram-helpers.js';
import type { Env } from './telegram-helpers.js';

const STRANGER = 999;

function setup(): { env: Env; h: UpdateHandler; d: AlertDelivery } {
  const env = makeEnv();
  const h = new UpdateHandler({
    store: env.store,
    gateway: env.gw,
    config: env.config,
    ownerUserId: OWNER,
    status: env.status,
    clock: env.clock,
    log: env.log,
  });
  const d = new AlertDelivery({ store: env.store, gateway: env.gw, config: env.config, explorer: EXPLORER, clock: env.clock, log: env.log });
  return { env, h, d };
}

let uid = 0;
const cbq = (data: string, over: { from?: number; chat?: number; msg?: number; id?: string } = {}): TgUpdate => ({
  update_id: ++uid,
  callback_query: {
    id: over.id ?? `cb${uid}`,
    from: { id: over.from ?? OWNER, username: 'landon' },
    message: { message_id: over.msg ?? 1, chat: { id: over.chat ?? CHATS.p0 } },
    data,
  },
});
const msg = (text: string, bot: BotName = 'p0', over: { from?: number; chat?: number } = {}): TgUpdate => ({
  update_id: ++uid,
  message: { message_id: 50 + uid, from: { id: over.from ?? OWNER, first_name: 'Landon' }, chat: { id: over.chat ?? CHATS[bot] }, text },
});

async function openP0(env: Env, d: AlertDelivery, over = {}): Promise<number> {
  const id = env.store.repos.alert.insert(newAlert(over));
  await d.deliverPending();
  return id;
}

describe('callback authorisation', () => {
  it('rejects an unauthorised user id, changes nothing and answers Not authorised', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', cbq(`ack:${id}`, { from: STRANGER }));
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    expect(env.store.repos.ack.forAlert(id)).toHaveLength(0);
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Not authorised');
    expect(env.gw.p0.edits).toHaveLength(0);
    await h.handle('p0', cbq(`snooze:${id}`, { from: STRANGER }));
    expect(env.store.repos.alert.get(id)?.snoozedUntil).toBeNull();
  });

  it('rejects the owner when the callback arrives from the wrong chat', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', cbq(`ack:${id}`, { chat: CHATS.p1 }));
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Not authorised');
  });

  it('rejects a callback with no message (inline) context', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    const u = cbq(`ack:${id}`);
    delete u.callback_query?.message;
    await h.handle('p0', u);
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
  });

  it('rejects when the callback arrives on a bot whose chat it does not match', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p1', cbq(`ack:${id}`)); // p0 chat id presented to the p1 bot
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
  });
});

describe('ACK / Snooze buttons', () => {
  it('ACK records the ack row, marks acked, edits with an ACK line, removes the keyboard and answers', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    env.clock.advance(42);
    await h.handle('p0', cbq(`ack:${id}`, { msg: 1 }));
    expect(env.store.repos.ack.forAlert(id)).toEqual([{ userId: OWNER, via: 'button', at: T0 + 42 }]);
    expect(env.store.repos.alert.get(id)?.ackedAt).toBe(T0 + 42);
    const edit = env.gw.p0.edits.at(-1);
    expect(edit).toMatchObject({ messageId: 1, keyboard: null });
    expect(edit?.text).toContain('✅ <b>ACK</b> by @landon');
    expect(edit?.text).toContain(`alert #${id}`);
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Acknowledged');
    expect(env.store.repos.telegramMessage.liveForAlert(id)).toHaveLength(0);
  });

  it('ACK is idempotent on a double press', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', cbq(`ack:${id}`));
    env.clock.advance(10);
    await h.handle('p0', cbq(`ack:${id}`));
    expect(env.store.repos.ack.forAlert(id)).toHaveLength(1);
    expect(env.store.repos.alert.get(id)?.ackedAt).toBe(T0);
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Already acknowledged');
    expect(env.gw.p0.edits.at(-1)?.keyboard).toBeNull();
  });

  it('after ACK no more repeats are sent', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', cbq(`ack:${id}`));
    env.clock.advance(3600);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('Snooze sets snoozed_until, appends the end time, keeps the keyboard and suppresses repeats', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', cbq(`snooze:${id}`));
    const until = T0 + 3600;
    expect(env.store.repos.alert.get(id)?.snoozedUntil).toBe(until);
    const edit = env.gw.p0.edits.at(-1);
    expect(edit?.text).toContain('Snoozed</b> until 2025-10-09 09:53 UTC');
    expect(edit?.keyboard?.[0]?.[0]?.callbackData).toBe(`ack:${id}`);
    expect(edit?.keyboard?.[1]?.[0]?.callbackData).toBe(`snooze:${id}`);
    expect(env.gw.p0.answers.at(-1)?.text).toContain('Snoozed');
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    env.clock.advance(1800);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
    env.clock.advance(1801);
    await d.tick();
    expect(env.gw.p0.sent).toHaveLength(2);
  });

  it('on an already-resolved alert answers "already resolved" and strips the keyboard', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    env.store.repos.alert.resolveKey('steakhouse-usdc/proxy/impl-slot', T0 + 10, 'fixed');
    await h.handle('p0', cbq(`ack:${id}`));
    expect(env.gw.p0.answers.at(-1)?.text).toMatch(/already resolved/i);
    expect(env.gw.p0.edits.at(-1)).toMatchObject({ messageId: 1, keyboard: null });
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    await h.handle('p0', cbq(`snooze:${id}`));
    expect(env.store.repos.alert.get(id)?.snoozedUntil).toBeNull();
  });

  it('on a superseded alert answers "already resolved" and strips the keyboard', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    const next = env.store.repos.alert.insert(newAlert({ kind: 'escalation', conditionKey: 'other' }));
    env.store.repos.alert.markSuperseded(id, next);
    await h.handle('p0', cbq(`ack:${id}`));
    expect(env.gw.p0.answers.at(-1)?.text).toMatch(/already resolved/i);
    expect(env.gw.p0.edits.at(-1)?.text).toContain(`replaced by alert #${next}`);
    expect(env.gw.p0.edits.at(-1)?.keyboard).toBeNull();
  });

  it('answers unknown alerts and malformed data without touching state', async () => {
    const { env, h } = setup();
    await h.handle('p0', cbq('ack:12345'));
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Unknown alert');
    await h.handle('p0', cbq('bogus'));
    expect(env.gw.p0.answers.at(-1)?.text).toBe('Unknown action');
  });

  it('still records the ACK when Telegram edits and answers fail', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    env.gw.p0.failNext(2);
    await h.handle('p0', cbq(`ack:${id}`));
    expect(env.store.repos.alert.get(id)?.ackedAt).toBe(T0);
    // edit failed, so the message is still tracked as live (a later press cleans it up)
    expect(env.store.repos.telegramMessage.liveForAlert(id)).toHaveLength(1);
  });
});

describe('/ack fallback', () => {
  it('acks via command, edits live messages and confirms', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p1', msg(`/ack ${id}`, 'p1'));
    expect(env.store.repos.ack.forAlert(id)).toEqual([{ userId: OWNER, via: 'command', at: T0 }]);
    expect(env.store.repos.alert.get(id)?.ackedAt).toBe(T0);
    expect(env.gw.p1.sent.at(-1)?.text).toContain(`Alert #${id} acknowledged`);
    expect(env.gw.p1.sent.at(-1)?.opts.replyToMessageId).toBeDefined();
    expect(env.gw.p0.edits.at(-1)).toMatchObject({ messageId: 1, keyboard: null });
  });

  it('works on all three bots, accepts @botname and #id forms', async () => {
    const { env, h, d } = setup();
    const a = await openP0(env, d, { conditionKey: 'a' });
    const b = await openP0(env, d, { conditionKey: 'b' });
    const c = await openP0(env, d, { conditionKey: 'c' });
    await h.handle('p0', msg(`/ack@sentinel_p0_bot ${a}`, 'p0'));
    await h.handle('p2', msg(`/ack #${b}`, 'p2'));
    await h.handle('p1', msg(`/ack ${c}`, 'p1'));
    expect([a, b, c].map((i) => env.store.repos.alert.get(i)?.ackedAt)).toEqual([T0, T0, T0]);
  });

  it('rejects a non-owner silently (no reply, no state change)', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', msg(`/ack ${id}`, 'p0', { from: STRANGER }));
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    expect(env.gw.p0.sent).toHaveLength(1); // only the original alert
    await h.handle('p0', msg('/status', 'p0', { from: STRANGER }));
    await h.handle('p1', msg('/status', 'p1', { from: STRANGER }));
    expect(env.gw.p1.sent).toHaveLength(0);
  });

  it('rejects the owner typing in the wrong chat', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', msg(`/ack ${id}`, 'p0', { chat: CHATS.p2 }));
    expect(env.store.repos.alert.get(id)?.ackedAt).toBeNull();
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('reports unknown, already acked, resolved and bad usage', async () => {
    const { env, h, d } = setup();
    const id = await openP0(env, d);
    await h.handle('p0', msg('/ack 777', 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('Unknown alert id #777');
    await h.handle('p0', msg('/ack banana', 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('Usage');
    await h.handle('p0', msg(`/ack ${id}`, 'p0'));
    await h.handle('p0', msg(`/ack ${id}`, 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('already acknowledged');
    expect(env.store.repos.ack.forAlert(id)).toHaveLength(1);
    const id2 = await openP0(env, d, { conditionKey: 'z' });
    env.store.repos.alert.resolveKey('z', T0, 'x');
    await h.handle('p0', msg(`/ack ${id2}`, 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('already resolved');
  });

  it('bare /ack lists open unacked P0 ids', async () => {
    const { env, h, d } = setup();
    const a = await openP0(env, d, { conditionKey: 'a', title: 'First <bad>' });
    const b = await openP0(env, d, { conditionKey: 'b' });
    await h.handle('p0', msg('/ack', 'p0'));
    const text = env.gw.p0.sent.at(-1)?.text ?? '';
    expect(text).toContain(`#${a}`);
    expect(text).toContain(`#${b}`);
    expect(text).toContain('First &lt;bad&gt;');
    await h.handle('p0', msg(`/ack ${a}`, 'p0'));
    await h.handle('p0', msg(`/ack ${b}`, 'p0'));
    await h.handle('p0', msg('/ack', 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('No open unacknowledged P0');
  });
});

function openCondition(env: Env, key: string, tier: 'P0' | 'P1', openedAt: number): void {
  const c: ConditionState = {
    key,
    holding: 'steakhouse-usdc',
    watcher: 'proxy',
    rule: 'proxy.impl_changed',
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
    context: { title: 't' },
  };
  env.store.repos.condition.upsert(c);
}

describe('/status', () => {
  it('replies on the P1 bot with providers, head, cycle, conditions, exposure, watchers and ping', async () => {
    const { env, h } = setup();
    openCondition(env, 'steakhouse-usdc/proxy/impl-slot', 'P0', T0 - 3600);
    openCondition(env, 'ousg/rwa/nav-stale<x>', 'P1', T0 - 120);
    env.store.repos.condition.upsert({ ...(env.store.repos.condition.get('ousg/rwa/nav-stale<x>') as ConditionState), key: 'closed/one', status: 'closed' });
    await h.handle('p1', msg('/status', 'p1'));
    const reply = env.gw.p1.sent.at(-1);
    expect(reply?.opts.replyToMessageId).toBeDefined();
    const t = reply?.text ?? '';
    expect(t).toContain('21,000,000'); // head
    expect(t).toContain('alchemy');
    expect(t).toContain('ACTIVE');
    expect(t).toContain('infura');
    expect(t).toMatch(/lag 1/);
    expect(t).toContain('342 ms');
    expect(t).toContain('Open conditions</b> (2)');
    expect(t).toContain('<b>P0</b> <code>steakhouse-usdc/proxy/impl-slot</code>');
    expect(t).toContain('ousg/rwa/nav-stale&lt;x&gt;');
    expect(t).not.toContain('closed/one');
    expect(t).toContain('steakhouse-usdc</code>: $123,456.78 — exit path OPEN (maxWithdraw covers position)');
    expect(t).toContain('ousg</code>: unknown — exit path CLOSED (redemption paused)');
    expect(t).toContain('rwa: 3 — boom &lt;bad&gt;');
    expect(t).toContain('proxy: 0');
    expect(t).toContain('last Healthchecks ping 45s ago');
    expect(t.length).toBeLessThanOrEqual(4096);
  });

  it('is only served on the P1 bot', async () => {
    const { env, h } = setup();
    await h.handle('p0', msg('/status', 'p0'));
    expect(env.gw.p0.sent.at(-1)?.text).toContain('P1 bot');
    expect(env.gw.p0.sent.at(-1)?.text).not.toContain('Open conditions');
    await h.handle('p2', msg('/status', 'p2'));
    expect(env.gw.p2.sent.at(-1)?.text).not.toContain('Open conditions');
  });

  it('copes with no providers, holdings, cycle or ping', async () => {
    const { env, h } = setup();
    env.status.snap = statusSnapshot({ providers: [], holdings: [], watchers: [], lastCycle: null, lastHealthcheckPingAt: null, headBlock: null, processedBlock: null });
    await h.handle('p1', msg('/status', 'p1'));
    const t = env.gw.p1.sent.at(-1)?.text ?? '';
    expect(t).toContain('none yet');
    expect(t).toContain('never');
    expect(t).toContain('Open conditions</b> (0)');
  });
});

describe('/help and /start', () => {
  it('replies with minimal help', async () => {
    const { env, h } = setup();
    await h.handle('p2', msg('/help', 'p2'));
    await h.handle('p2', msg('/start', 'p2'));
    expect(env.gw.p2.sent).toHaveLength(2);
    expect(env.gw.p2.sent[0]?.text).toContain('/ack');
  });

  it('ignores non-commands and unknown commands', async () => {
    const { env, h } = setup();
    await h.handle('p0', msg('hello', 'p0'));
    await h.handle('p0', msg('/nope', 'p0'));
    await h.handle('p0', { update_id: 5000 });
    expect(env.gw.p0.sent).toHaveLength(0);
  });
});
