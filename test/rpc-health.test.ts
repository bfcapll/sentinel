import { describe, expect, it } from 'vitest';
import { RpcHealth } from '../src/rpc/health.js';
import { rpcOpsSamples } from '../src/rpc/ops.js';

const RULES = { max_block_diff: 5, diff_secs: 60, stall_secs: 90, blind_secs: 300 };
const mk = () =>
  new RpcHealth(RULES, [
    { name: 'alchemy', role: 'primary' },
    { name: 'infura', role: 'secondary' },
    { name: 'drpc', role: 'canary' },
  ], 0);

/** Advance every listed provider one block every 12s up to `until`. */
function tick(h: RpcHealth, heads: Record<string, number>, now: number): void {
  for (const [n, head] of Object.entries(heads)) h.observeHead(n, head, now);
}

describe('RPC health rules (PLAN.md §3.2)', () => {
  it('healthy providers raise nothing', () => {
    const h = mk();
    for (let t = 0; t <= 200; t += 12) tick(h, { alchemy: 100 + t / 12, infura: 100 + t / 12, drpc: 100 + t / 12 }, t);
    const ev = h.evaluate(200);
    expect(ev).toMatchObject({ rpcLag: false, chainBlind: false, active: 'alchemy', canaryAdvancing: true });
  });

  it('divergence > 5 blocks only alerts after it persists > 60s', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 100, drpc: 100 }, 0);
    tick(h, { alchemy: 100, infura: 110, drpc: 110 }, 12);
    expect(h.evaluate(12).rpcLag).toBe(false);
    tick(h, { alchemy: 101, infura: 115, drpc: 115 }, 60);
    expect(h.evaluate(60).rpcLag).toBe(false);
    tick(h, { alchemy: 102, infura: 120, drpc: 120 }, 80);
    const ev = h.evaluate(80);
    expect(ev.rpcLag).toBe(true);
    expect(ev.reasons.join()).toMatch(/differ by/);
    expect(ev.active).toBe('infura'); // primary is >5 behind: fail over
  });

  it('a brief divergence that heals never alerts', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 110 }, 0);
    h.evaluate(30);
    tick(h, { alchemy: 110, infura: 110 }, 40);
    h.evaluate(40);
    tick(h, { alchemy: 111, infura: 130 }, 100);
    expect(h.evaluate(100).rpcLag).toBe(false); // divergence clock restarted at 100
  });

  it('a provider silent > 90s raises ops.rpc_lag and the other becomes active', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 100, drpc: 100 }, 0);
    for (let t = 12; t <= 120; t += 12) tick(h, { infura: 100 + t / 12, drpc: 100 + t / 12 }, t);
    const ev = h.evaluate(120);
    expect(ev.rpcLag).toBe(true);
    expect(ev.chainBlind).toBe(false);
    expect(ev.active).toBe('infura');
    expect(ev.canaryAdvancing).toBe(true);
  });

  it('both providers silent > 5 min is chain_blind, and the canary tells us who is at fault', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 100, drpc: 100 }, 0);
    for (let t = 12; t <= 400; t += 12) tick(h, { drpc: 100 + t / 12 }, t);
    const ev = h.evaluate(400);
    expect(ev.chainBlind).toBe(true);
    expect(ev.canaryAdvancing).toBe(true);
    const samples = rpcOpsSamples(ev);
    expect(samples.find((s) => s.key === 'ops/rpc/chain_blind')).toMatchObject({ tier: 'P0' });
    expect(samples.find((s) => s.key === 'ops/rpc/rpc_lag')).toMatchObject({ tier: 'P1' });
    expect(samples.find((s) => s.key === 'ops/rpc/chain_blind')?.context.detail).toMatch(/canary IS advancing/);
  });

  it('error bursts fail over; failback waits for a clean minute', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 100 }, 0);
    for (let i = 0; i < 5; i++) h.recordError('alchemy', 1 + i);
    expect(h.evaluate(6).active).toBe('infura');
    tick(h, { alchemy: 101, infura: 101 }, 70);
    expect(h.evaluate(70).active).toBe('infura'); // errors aged out at 61+, quiet clock starts at 70
    tick(h, { alchemy: 105, infura: 105 }, 140);
    expect(h.evaluate(140).active).toBe('alchemy');
  });

  it('recovery clears the OPS samples', () => {
    const h = mk();
    tick(h, { alchemy: 100, infura: 100 }, 0);
    for (let t = 12; t <= 400; t += 12) tick(h, {}, t);
    expect(h.evaluate(400).chainBlind).toBe(true);
    tick(h, { alchemy: 150, infura: 150 }, 410);
    const s = rpcOpsSamples(h.evaluate(410));
    expect(s.every((x) => x.tier === null && x.clear)).toBe(true);
  });
});
