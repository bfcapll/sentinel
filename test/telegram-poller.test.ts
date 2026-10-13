import { describe, expect, it } from 'vitest';
import { UpdateHandler } from '../src/telegram/commands.js';
import { TelegramService } from '../src/telegram/index.js';
import { UpdatePoller, offsetKey } from '../src/telegram/poller.js';
import type { TgUpdate } from '../src/telegram/api.js';
import { CHATS, EXPLORER, OWNER, insertAlert, makeEnv, newAlert } from './telegram-helpers.js';
import type { Env } from './telegram-helpers.js';

function setup(): { env: Env; poller: UpdatePoller; handler: UpdateHandler } {
  const env = makeEnv();
  const handler = new UpdateHandler({
    store: env.store,
    gateway: env.gw,
    config: env.config,
    ownerUserId: OWNER,
    status: env.status,
    clock: env.clock,
    log: env.log,
  });
  const poller = new UpdatePoller({ store: env.store, gateway: env.gw, handler, clock: env.clock, log: env.log, pollTimeoutS: 30, maxBackoffMs: 20 });
  return { env, poller, handler };
}

const ackCmd = (id: number, updateId: number): TgUpdate => ({
  update_id: updateId,
  message: { message_id: 1, from: { id: OWNER }, chat: { id: CHATS.p0 }, text: `/ack ${id}` },
});

async function until(cond: () => boolean, ms = 2000): Promise<void> {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('UpdatePoller', () => {
  it('pollOnce handles updates and persists the next offset per bot', async () => {
    const { env, poller } = setup();
    const id = insertAlert(env.store, { sendState: 'sent' });
    env.gw.p0.pushUpdate(ackCmd(id, 41));
    expect(await poller.pollOnce('p0', 0)).toBe(1);
    expect(env.store.repos.kv.get(offsetKey('p0'))).toBe('42');
    expect(env.store.repos.kv.get(offsetKey('p1'))).toBeUndefined();
    expect(env.store.repos.alert.get(id)?.ackedAt).not.toBeNull();
    // already confirmed updates are not delivered again
    expect(await poller.pollOnce('p0', 0)).toBe(0);
  });

  it('a throwing handler does not wedge the loop or block the offset', async () => {
    const { env, poller, handler } = setup();
    let calls = 0;
    handler.handle = () => {
      calls++;
      return Promise.reject(new Error('boom'));
    };
    env.gw.p0.pushUpdate({ update_id: 7 });
    env.gw.p0.pushUpdate({ update_id: 8 });
    await poller.pollOnce('p0', 0);
    expect(calls).toBe(2);
    expect(env.store.repos.kv.get(offsetKey('p0'))).toBe('9');
  });

  it('start() long-polls all bots, dispatches pushed updates, and stop() aborts promptly', async () => {
    const { env, poller } = setup();
    const id = insertAlert(env.store, { sendState: 'sent' });
    poller.start();
    expect(poller.running).toBe(true);
    env.gw.p0.pushUpdate(ackCmd(id, 1));
    await until(() => env.store.repos.alert.get(id)?.ackedAt !== null);
    const t0 = Date.now();
    await poller.stop(); // loops are parked in a 30s long poll
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(poller.running).toBe(false);
  });

  it('backs off on getUpdates errors and recovers', async () => {
    const { env, poller } = setup();
    const id = insertAlert(env.store, { sendState: 'sent' });
    const orig = env.gw.p0.getUpdates.bind(env.gw.p0);
    let fails = 3;
    env.gw.p0.getUpdates = (...a: Parameters<typeof orig>) => {
      if (fails-- > 0) return Promise.reject(new Error('502'));
      return orig(...a);
    };
    env.gw.p0.pushUpdate(ackCmd(id, 3));
    poller.start();
    await until(() => env.store.repos.alert.get(id)?.ackedAt !== null);
    await poller.stop();
    expect(fails).toBeLessThan(0);
  });

  it('resumes from the persisted offset after a restart', async () => {
    const { env, poller } = setup();
    env.store.repos.kv.set(offsetKey('p0'), '10', 0);
    env.gw.p0.pushUpdate({ update_id: 5 });
    env.gw.p0.pushUpdate({ update_id: 10, message: { message_id: 1, from: { id: OWNER }, chat: { id: CHATS.p0 }, text: '/help' } });
    expect(await poller.pollOnce('p0', 0)).toBe(1);
    expect(env.gw.p0.sent).toHaveLength(1);
  });

  it('stop() is safe when never started and twice', async () => {
    const { poller } = setup();
    await poller.stop();
    poller.start();
    await poller.stop();
    await poller.stop();
  });
});

describe('TelegramService', () => {
  it('tick() delivers pending alerts (delivery + digest, no pollers)', async () => {
    const env = makeEnv();
    const svc = new TelegramService({
      store: env.store,
      gateway: env.gw,
      config: env.config,
      explorer: EXPLORER,
      ownerUserId: OWNER,
      status: env.status,
      clock: env.clock,
      log: env.log,
    });
    env.store.repos.alert.insert(newAlert());
    await svc.tick();
    expect(env.gw.p0.sent).toHaveLength(1);
    expect(svc.poller.running).toBe(false);
  });

  it('start() runs an immediate tick and the poller; stop() halts everything', async () => {
    const env = makeEnv();
    const svc = new TelegramService({
      store: env.store,
      gateway: env.gw,
      config: env.config,
      explorer: EXPLORER,
      ownerUserId: OWNER,
      status: env.status,
      clock: env.clock,
      log: env.log,
      tickIntervalMs: 10,
      pollTimeoutS: 30,
    });
    env.store.repos.alert.insert(newAlert());
    svc.start();
    await until(() => env.gw.p0.sent.length === 1);
    expect(svc.poller.running).toBe(true);
    await svc.stop();
    expect(svc.poller.running).toBe(false);
    env.store.repos.alert.insert(newAlert({ conditionKey: 'late' }));
    await new Promise((r) => setTimeout(r, 40));
    expect(env.gw.p0.sent).toHaveLength(1);
  });
});
