import { describe, expect, it } from 'vitest';
import { CursorPlanner } from '../src/chain/cursor.js';
import { BlockTracker } from '../src/chain/tracker.js';
import { silentLogger } from '../src/log.js';
import { proxyUpgradeScenario } from '../src/replay/scenarios.js';
import { SyntheticChain } from '../src/replay/synthetic.js';
import type { HeadSource } from '../src/rpc/ws.js';
import { Store } from '../src/store/db.js';
import { makeClient } from './helpers.js';

const OPTS = { chain: 'ethereum', rescanBlocks: 12, maxCatchupBlocks: 5000 };

async function commit(store: Store, planner: CursorPlanner, chain: SyntheticChain, n: number): Promise<void> {
  const client = makeClient(chain);
  const h = await client.getBlock(n);
  store.tx(() => planner.commit(h, 1));
}

describe('CursorPlanner', () => {
  it('first run starts at the target; then plans contiguous ranges; null when caught up', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const store = Store.open(':memory:');
    const planner = new CursorPlanner(store, makeClient(chain), OPTS, silentLogger());
    const p1 = await planner.plan(1000);
    expect(p1).toMatchObject({ from: 1000, to: 1000 });
    await commit(store, planner, chain, 1000);
    expect(await planner.plan(1000)).toBeNull();
    const p2 = await planner.plan(1003);
    expect(p2).toMatchObject({ from: 1001, to: 1003 });
    expect(p2?.reorg).toBeUndefined();
  });

  it('detects a reorg from the cursor hash, rewinds 12 blocks and rescans', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const store = Store.open(':memory:');
    const planner = new CursorPlanner(store, makeClient(chain), OPTS, silentLogger());
    for (let b = 1000; b <= 1030; b++) await commit(store, planner, chain, b);
    chain.scenario = { ...chain.scenario, reorg: { fromBlock: 1028, salt: 'fork' } };
    const planner2 = new CursorPlanner(store, makeClient(chain), OPTS, silentLogger());
    const plan = await planner2.plan(1032);
    expect(plan?.reorg).toMatchObject({ detectedAt: 1030, rewoundTo: 1018 });
    expect(plan).toMatchObject({ from: 1019, to: 1032 });
    expect(store.repos.cursor.get('ethereum')?.block).toBe(1018);
    expect(store.repos.blockLog.get(1025)).toBeUndefined(); // stale hashes dropped
  });

  it('detects a parent-hash break on a contiguous next block', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const store = Store.open(':memory:');
    const planner = new CursorPlanner(store, makeClient(chain), OPTS, silentLogger());
    await commit(store, planner, chain, 1000);
    // Block 1000 is unchanged, but the node now serves a block 1001 whose parent differs.
    const forked = {
      label: 'forked',
      request: async (m: string, p?: readonly unknown[]) => {
        const r = await chain.request(m, p);
        if (m === 'eth_getBlockByNumber' && p?.[0] === '0x3e9') return { ...(r as object), parentHash: `0x${'9'.repeat(64)}` };
        return r;
      },
    };
    const plan = await new CursorPlanner(store, makeClient(forked), OPTS, silentLogger()).plan(1001);
    expect(plan?.reorg?.reason).toMatch(/parentHash/);
  });

  it('skips log history when the gap exceeds the catch-up limit but still plans the target', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const store = Store.open(':memory:');
    const planner = new CursorPlanner(store, makeClient(chain), { ...OPTS, maxCatchupBlocks: 10 }, silentLogger());
    await commit(store, planner, chain, 1000);
    const plan = await planner.plan(1050);
    expect(plan?.skipped).toEqual({ fromBlock: 1001, toBlock: 1040 });
    expect(plan).toMatchObject({ from: 1041, to: 1050 });
  });

  it('commit writes cursor + block_log together', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const store = Store.open(':memory:');
    const planner = new CursorPlanner(store, makeClient(chain), OPTS, silentLogger());
    await commit(store, planner, chain, 1005);
    expect(store.repos.cursor.get('ethereum')).toMatchObject({ block: 1005, hash: chain.hashOf(1005) });
    expect(store.repos.blockLog.get(1005)?.parentHash).toBe(chain.hashOf(1004));
  });
});

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

class FakeWs implements HeadSource {
  onHead: (n: number) => void = () => undefined;
  stopped = false;
  start(onHead: (n: number) => void): void {
    this.onHead = onHead;
  }
  stop(): void {
    this.stopped = true;
  }
}

describe('BlockTracker', () => {
  const opts = { pollIntervalMs: 1_000_000, wsSilenceMs: 20_000 };

  it('emits each new head once and ignores stale ones', () => {
    const ws = new FakeWs();
    const heads: number[] = [];
    const t = new BlockTracker(async () => 0, ws, opts, (h) => heads.push(h), silentLogger());
    t.start();
    ws.onHead(10);
    ws.onHead(10);
    ws.onHead(9);
    ws.onHead(11);
    t.stop();
    expect(heads).toEqual([10, 11]);
    expect(ws.stopped).toBe(true);
  });

  it('polls over HTTP only when the WebSocket has gone silent', async () => {
    let now = 0;
    const ws = new FakeWs();
    let polls = 0;
    const heads: Array<[number, string]> = [];
    const t = new BlockTracker(async () => 100 + ++polls, ws, opts, (h, s) => heads.push([h, s]), silentLogger(), () => now);
    t.start();
    await flush(); // startup poll (head 101)
    ws.onHead(200);
    now = 1000;
    expect(t.mode()).toBe('ws');
    await t.pollOnce(false);
    const before = polls;
    now = 30_000; // > 20s since last ws head
    expect(t.mode()).toBe('poll');
    await t.pollOnce(false);
    expect(polls).toBe(before + 1);
    t.stop();
    expect(heads[0]?.[1]).toBe('poll');
    expect(heads.some(([h, s]) => h === 200 && s === 'ws')).toBe(true);
  });

  it('works without a WebSocket (poll only) and survives poll errors', async () => {
    let n = 0;
    const heads: number[] = [];
    const t = new BlockTracker(
      async () => {
        if (++n === 2) throw new Error('rpc down');
        return n;
      },
      null,
      { pollIntervalMs: 1_000_000, wsSilenceMs: 1 },
      (h) => heads.push(h),
      silentLogger(),
    );
    t.start();
    await flush(); // startup poll -> 1
    await t.pollOnce(false); // throws -> logged, no head
    await t.pollOnce(false); // -> 3
    t.stop();
    expect(heads).toEqual([1, 3]);
  });
});
