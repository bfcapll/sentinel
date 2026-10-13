import { describe, expect, it } from 'vitest';
import { NullPinger } from '../src/health/healthchecks.js';
import { silentLogger } from '../src/log.js';
import { RpcClient } from '../src/rpc/client.js';
import { RpcHealth, type HealthEvaluation } from '../src/rpc/health.js';
import { RpcError, type RpcTransport } from '../src/rpc/types.js';
import { DEMO, proxyUpgradeScenario } from '../src/replay/scenarios.js';
import { SyntheticChain } from '../src/replay/synthetic.js';
import { Scheduler } from '../src/scheduler.js';
import { Store } from '../src/store/db.js';
import { FixedClock } from '../src/time.js';
import type { Watcher } from '../src/watchers/types.js';
import { proxyWatcher } from '../src/watchers/proxy.js';
import { demoConfig, makeClient, makeScheduler } from './helpers.js';

const IMPL_KEY = 'demo-proxy/proxy/token/implementation';

describe('scheduler cycle', () => {
  it('quiet blocks create no alerts and advance the cursor each cycle', async () => {
    const h = makeScheduler();
    for (let b = 1000; b < 1010; b++) await h.scheduler.runAtBlock(b);
    expect(h.store.repos.alert.list()).toEqual([]);
    expect(h.store.repos.cursor.get('ethereum')?.block).toBe(1009);
  });

  it('a silent slot change (no event) raises exactly one P0 and does not re-alert', async () => {
    const h = makeScheduler();
    for (let b = 1015; b <= 1025; b++) await h.scheduler.runAtBlock(b);
    const alerts = h.store.repos.alert.list();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ conditionKey: IMPL_KEY, tier: 'P0', block: 1020, sendState: 'pending', exitPathOpen: true });
    expect(alerts[0]!.exposureUsd).toBe(1_000_000);
    expect(alerts[0]!.message).toContain('Exit path: OPEN');
    expect(h.store.repos.condition.get(IMPL_KEY)).toMatchObject({ status: 'open', tier: 'P0' });
  });

  it('commits cursor, conditions, alerts and snapshots in one transaction', async () => {
    const h = makeScheduler();
    // Make the commit blow up after rules ran: the whole cycle, cursor included, must roll back.
    const orig = h.store.repos.cursor.set.bind(h.store.repos.cursor);
    h.store.repos.cursor.set = () => {
      throw new Error('disk full');
    };
    await expect(h.scheduler.runAtBlock(1020)).rejects.toThrow('disk full');
    h.store.repos.cursor.set = orig;
    expect(h.store.repos.cursor.get('ethereum')).toBeUndefined();
    expect(h.store.repos.alert.list()).toEqual([]);
    expect(h.store.repos.condition.all().size).toBe(0);
    // ...and the retry succeeds from the same cursor.
    await h.scheduler.runAtBlock(1020);
    expect(h.store.repos.alert.list()).toHaveLength(1);
  });

  it('pings the heartbeat only after a fully committed cycle', async () => {
    const pinger = new NullPinger();
    const h = makeScheduler({ scheduler: { pinger, useBlockTime: false } });
    await h.scheduler.runAtBlock(1000);
    expect(pinger.pings).toHaveLength(1);

    // Every provider down: the cycle fails, nothing commits, no ping.
    const dead: RpcTransport = { label: 'dead', request: () => Promise.reject(new RpcError('down', { transient: true })) };
    const clock = new FixedClock(1_700_000_000);
    const pinger2 = new NullPinger();
    const sched = new Scheduler({
      config: demoConfig(), store: h.store, reader: makeClient(dead, clock), log: silentLogger(), clock, pinger: pinger2, holdingFilter: [DEMO.holding],
    });
    await expect(sched.runAtBlock(1001)).rejects.toThrow();
    expect(pinger2.pings).toHaveLength(0);
    expect(h.store.repos.cursor.get('ethereum')?.block).toBe(1000);
  });

  it('chaos: primary dies mid-run, failover keeps cycling without duplicate alerts', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    let primaryUp = true;
    const flaky: RpcTransport = {
      label: 'flaky',
      request: (m, p) => (primaryUp ? chain.request(m, p) : Promise.reject(new RpcError('primary down', { transient: true }))),
    };
    const clock = new FixedClock(1_700_000_000);
    const providers = [
      { name: 'primary', role: 'primary' as const, transport: flaky },
      { name: 'secondary', role: 'secondary' as const, transport: chain },
    ];
    const reader = new RpcClient({
      providers,
      health: new RpcHealth({ max_block_diff: 5, diff_secs: 60, stall_secs: 90, blind_secs: 300 }, providers, clock.now()),
      clock,
      log: silentLogger(),
    });
    const store = Store.open(':memory:');
    const sched = new Scheduler({ config: demoConfig(), store, reader, log: silentLogger(), clock, useBlockTime: true, holdingFilter: [DEMO.holding] });
    for (let b = 1010; b <= 1019; b++) await sched.runAtBlock(b);
    primaryUp = false;
    for (let b = 1020; b <= 1035; b++) await sched.runAtBlock(b);
    const keys = store.repos.alert.list().map((a) => a.conditionKey).sort();
    expect(keys).toEqual(['demo-proxy/proxy/token/admin', IMPL_KEY]);
  });

  it('reorg: cursor rewinds, the rescan re-observes conditions and never duplicates alerts', async () => {
    const h = makeScheduler();
    for (let b = 1015; b <= 1025; b++) await h.scheduler.runAtBlock(b);
    expect(h.store.repos.alert.list()).toHaveLength(1);
    h.chain.scenario = { ...h.chain.scenario, reorg: { fromBlock: 1022, salt: 'fork' } };
    const r = await h.scheduler.runAtBlock(1027);
    expect(r?.reorg).toMatchObject({ detectedAt: 1025, rewoundTo: 1013 });
    expect(h.store.repos.alert.list()).toHaveLength(1);
    expect(h.store.repos.cursor.get('ethereum')?.block).toBe(1027);
  });

  it('the admin change enriches the alert with the tx hash from the AdminChanged event', async () => {
    const h = makeScheduler();
    for (let b = 1025; b <= 1031; b++) await h.scheduler.runAtBlock(b);
    const admin = h.store.repos.alert.list().find((a) => a.conditionKey.endsWith('/admin'))!;
    expect(admin.txHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(admin.message).toContain('AdminChanged(newAdmin=');
  });

  it('keeps firing nothing for unchanged state across restarts (state is in SQLite)', async () => {
    const h = makeScheduler();
    for (let b = 1018; b <= 1022; b++) await h.scheduler.runAtBlock(b);
    const second = new Scheduler({ config: h.config, store: h.store, reader: makeClient(h.chain, h.clock), log: silentLogger(), clock: h.clock, useBlockTime: true, holdingFilter: [DEMO.holding] });
    for (let b = 1023; b <= 1028; b++) await second.runAtBlock(b);
    expect(h.store.repos.alert.list()).toHaveLength(1);
  });

  it('exposes a status snapshot for /status and the digest', async () => {
    const h = makeScheduler();
    await h.scheduler.runAtBlock(1020);
    const s = h.scheduler.snapshot();
    expect(s.processedBlock).toBe(1020);
    expect(s.holdings[0]).toMatchObject({ id: DEMO.holding, exposureUsd: 1_000_000, exitPathOpen: true, watchers: ['proxy'] });
    expect(s.watchers[0]).toMatchObject({ name: 'proxy', consecutiveErrors: 0 });
    expect(s.lastCycle?.block).toBe(1020);
  });
});

describe('watcher errors', () => {
  const boom = (name: string, p0Class: boolean): Watcher => ({
    ...proxyWatcher,
    name,
    p0Class,
    fold: () => {
      throw new Error('decode exploded');
    },
  });

  it('3 consecutive failing cycles raise OPS P1 (ops.watcher_error) and recovery resolves it', async () => {
    let broken = true;
    const w: Watcher = { ...proxyWatcher, name: 'flaky', fold: (i) => (broken ? boom('flaky', false).fold(i) : proxyWatcher.fold(i)) };
    const h = makeScheduler({ scheduler: { watchers: [w] } });
    await h.scheduler.runAtBlock(1000);
    await h.scheduler.runAtBlock(1001);
    expect(h.store.repos.alert.list()).toHaveLength(0);
    await h.scheduler.runAtBlock(1002);
    const a = h.store.repos.alert.list();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ conditionKey: 'ops/watcher/flaky/error', tier: 'P1', isOps: true });
    expect(a[0]!.message).toContain('decode exploded');
    broken = false;
    await h.scheduler.runAtBlock(1003);
    expect(h.store.repos.alert.list()[0]!.resolvedAt).not.toBeNull();
  });

  it('a P0-class watcher failing for 10 minutes raises OPS P0', async () => {
    const h = makeScheduler({ scheduler: { watchers: [boom('proxy', true)] } });
    // 12s blocks: 1000..1050 spans 10 minutes of block time.
    for (let b = 1000; b <= 1051; b++) await h.scheduler.runAtBlock(b);
    const byTier = h.store.repos.alert.list().map((a) => a.tier);
    expect(byTier).toEqual(['P1', 'P0']);
    expect(h.store.repos.alert.list()[1]).toMatchObject({ kind: 'escalation', conditionKey: 'ops/watcher/proxy/error' });
  });
});

describe('ops conditions via opsTick', () => {
  const evaluation = (over: Partial<HealthEvaluation>): HealthEvaluation => ({
    active: 'alchemy',
    rpcLag: false,
    chainBlind: false,
    reasons: [],
    canaryAdvancing: true,
    providers: [{ name: 'alchemy', role: 'primary', head: 100, lagBlocks: 0, stalledForS: 0, errors1m: 0 }],
    ...over,
  });

  it('rpc lag is OPS P1, chain blind is OPS P0, both resolve on recovery', () => {
    let ev = evaluation({});
    const h = makeScheduler({ scheduler: { rpcHealth: () => ev } });
    h.scheduler.opsTick();
    expect(h.store.repos.alert.list()).toHaveLength(0);
    ev = evaluation({ rpcLag: true, reasons: ['alchemy has not advanced for 120s'] });
    h.scheduler.opsTick();
    ev = evaluation({ rpcLag: true, chainBlind: true });
    h.scheduler.opsTick();
    expect(h.store.repos.alert.list().map((a) => [a.conditionKey, a.tier])).toEqual([
      ['ops/rpc/rpc_lag', 'P1'],
      ['ops/rpc/chain_blind', 'P0'],
    ]);
    expect(h.store.repos.alert.list()[1]!.message).toMatch(/OPS|ops/);
    ev = evaluation({});
    h.scheduler.opsTick();
    expect(h.store.repos.alert.list().every((a) => a.resolvedAt !== null)).toBe(true);
    expect(h.store.repos.rpcHealth.all()[0]).toMatchObject({ provider: 'alchemy', head: 100 });
  });
});
