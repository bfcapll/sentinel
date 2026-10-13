import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { parseAbi } from 'viem';
import { afterEach, describe, expect, it } from 'vitest';
import type { Address } from '../src/config/schema.js';
import { silentLogger } from '../src/log.js';
import { RpcClient } from '../src/rpc/client.js';
import { emptyFixture, FixtureTransport, RecordingTransport, requestKey } from '../src/rpc/fixture.js';
import { RpcHealth } from '../src/rpc/health.js';
import { HttpTransport, redactUrl } from '../src/rpc/http.js';
import { RpcError, type RpcTransport } from '../src/rpc/types.js';
import { proxyUpgradeScenario, DEMO } from '../src/replay/scenarios.js';
import { SyntheticChain } from '../src/replay/synthetic.js';
import { FixedClock } from '../src/time.js';

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)']);
const clock = new FixedClock(1_700_000_000);
const RULES = { max_block_diff: 5, diff_secs: 60, stall_secs: 90, blind_secs: 300 };

function dual(primary: RpcTransport, secondary: RpcTransport): RpcClient {
  const providers = [
    { name: 'primary', role: 'primary' as const, transport: primary },
    { name: 'secondary', role: 'secondary' as const, transport: secondary },
  ];
  return new RpcClient({ providers, health: new RpcHealth(RULES, providers, clock.now()), clock, log: silentLogger() });
}
const failing = (transient = true): RpcTransport => ({
  label: 'bad',
  request: () => Promise.reject(new RpcError('boom', { transient })),
});

describe('RpcClient', () => {
  it('fails over to the secondary on transient errors', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(failing(), chain);
    expect((await c.getBlock(1000)).number).toBe(1000);
  });

  it('does not fail over on deterministic errors (reverts, bad params)', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(failing(false), chain);
    await expect(c.getBlock(1000)).rejects.toThrow('boom');
    expect(chain.calls).toBe(0);
  });

  it('throws when every provider fails', async () => {
    await expect(dual(failing(), failing()).getBlock(1)).rejects.toThrow(/all providers failed/);
  });

  it('caches per block and de-duplicates concurrent identical requests', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(chain, failing());
    const slot = `0x${'0'.repeat(64)}` as const;
    await Promise.all([c.getStorageAt(DEMO.token, slot, 1000), c.getStorageAt(DEMO.token, slot, 1000), c.getStorageAt(DEMO.token, slot, 1000)]);
    await c.getStorageAt(DEMO.token, slot, 1000);
    expect(chain.calls).toBe(1);
    await c.getStorageAt(DEMO.token, slot, 1001);
    expect(chain.calls).toBe(2);
  });

  it('evicts cache buckets older than the retention window', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(chain, failing());
    for (let b = 1000; b < 1010; b++) await c.getBlock(b);
    expect(c.cacheSize()).toBeLessThanOrEqual(4);
  });

  it('batches multicalls (<=60 per eth_call) and shares identical reads across callers', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(chain, failing());
    const call = (i: number) => ({ address: DEMO.token as Address, abi: ERC20, functionName: 'balanceOf', args: [`0x${i.toString(16).padStart(40, '0')}`] });
    const calls = Array.from({ length: 130 }, (_, i) => call(i + 1));
    const res = await c.multicall(calls, 1000);
    expect(res).toHaveLength(130);
    expect(res.every((r) => r.ok)).toBe(true);
    expect(chain.calls).toBe(3); // 60 + 60 + 10
    const wallet = await Promise.all([
      c.multicall([{ address: DEMO.token, abi: ERC20, functionName: 'balanceOf', args: [DEMO.wallet] }], 1000),
      c.multicall([{ address: DEMO.token, abi: ERC20, functionName: 'balanceOf', args: [DEMO.wallet] }], 1000),
    ]);
    expect(wallet[0]![0]).toEqual({ ok: true, value: 1_000_000n * 10n ** 6n });
    expect(chain.calls).toBe(4);
  });

  it('halves the getLogs range when a provider rejects it', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const seen: number[] = [];
    const picky: RpcTransport = {
      label: 'picky',
      request: (m, p) => {
        if (m === 'eth_getLogs') {
          const f = (p as Array<{ fromBlock: string; toBlock: string }>)[0]!;
          const span = Number.parseInt(f.toBlock, 16) - Number.parseInt(f.fromBlock, 16) + 1;
          seen.push(span);
          if (span > 10) return Promise.reject(new RpcError('query returned more than 10000 results', { transient: false, code: -32602 }));
        }
        return chain.request(m, p);
      },
    };
    const c = dual(picky, failing());
    const logs = await c.getLogs({ addresses: [DEMO.token], fromBlock: 1000, toBlock: 1040 });
    expect(logs.map((l) => l.blockNumber)).toEqual([DEMO.adminChangeBlock]);
    expect(Math.max(...seen)).toBeGreaterThan(10);
    expect(seen.at(-1)).toBeLessThanOrEqual(10);
  });

  it('pollHeads feeds the health rules for every provider and survives a dead one', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const c = dual(chain, failing());
    const r = await c.pollHeads();
    expect(r.find((x) => x.name === 'primary')?.head).toBe(1100);
    expect(r.find((x) => x.name === 'secondary')?.error).toBeDefined();
    expect(c.health.evaluate(clock.now()).providers.find((p) => p.name === 'secondary')?.errors1m).toBe(1);
  });
});

describe('fixtures', () => {
  it('records responses and replays them with no network; a miss is a loud, deterministic error', async () => {
    const chain = new SyntheticChain(proxyUpgradeScenario());
    const fx = emptyFixture();
    const rec = new RecordingTransport(chain, fx);
    const a = await rec.request('eth_getBlockByNumber', ['0x3e8', false]);
    const replay = new FixtureTransport(fx);
    expect(await replay.request('eth_getBlockByNumber', ['0x3e8', false])).toEqual(a);
    const miss = replay.request('eth_getBlockByNumber', ['0x3e9', false]);
    await expect(miss).rejects.toMatchObject({ transient: false });
    expect(replay.misses).toHaveLength(1);
  });

  it('keys are insensitive to address case and object key order', () => {
    expect(requestKey('eth_getLogs', [{ address: ['0xAbC0000000000000000000000000000000000001'], fromBlock: '0x1' }])).toBe(
      requestKey('eth_getLogs', [{ fromBlock: '0x1', address: ['0xabc0000000000000000000000000000000000001'] }]),
    );
  });

  it('records deterministic errors too', async () => {
    const fx = emptyFixture();
    const rec = new RecordingTransport(failing(false), fx);
    await expect(rec.request('eth_call', [])).rejects.toThrow();
    await expect(new FixtureTransport(fx).request('eth_call', [])).rejects.toThrow('boom');
  });
});

describe('HttpTransport', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function serve(handler: (body: unknown, status: { code: number }) => unknown): Promise<{ url: string; requests: unknown[] }> {
    const requests: unknown[] = [];
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data) as unknown;
        requests.push(body);
        const status = { code: 200 };
        const out = handler(body, status);
        res.writeHead(status.code, { 'content-type': 'application/json' });
        res.end(JSON.stringify(out));
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v2/SECRETKEY`, requests };
  }

  it('coalesces concurrent requests into one JSON-RPC batch and matches results by id', async () => {
    const { url, requests } = await serve((body) =>
      (body as Array<{ id: number; method: string }>).map((r) => ({ jsonrpc: '2.0', id: r.id, result: r.method })).reverse(),
    );
    const t = new HttpTransport({ url, label: 'x', timeoutMs: 2000, batch: { maxSize: 50, waitMs: 5 } });
    const [a, b, c] = await Promise.all([t.request('m1'), t.request('m2'), t.request('m3')]);
    expect([a, b, c]).toEqual(['m1', 'm2', 'm3']);
    expect(requests).toHaveLength(1);
  });

  it('classifies HTTP 429/5xx and network errors as transient, reverts as deterministic, and hides the key', async () => {
    const { url } = await serve((_b, s) => {
      s.code = 429;
      return {};
    });
    const t = new HttpTransport({ url, label: 'alchemy', timeoutMs: 2000 });
    const e1 = await t.request('eth_call').catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(RpcError);
    expect((e1 as RpcError).transient).toBe(true);
    expect((e1 as RpcError).message).not.toContain('SECRETKEY');

    await new Promise<void>((r) => server!.close(() => r()));
    const { url: url2 } = await serve((b) => ({ jsonrpc: '2.0', id: (b as { id: number }).id, error: { code: 3, message: 'execution reverted' } }));
    const e2 = await new HttpTransport({ url: url2, label: 'x', timeoutMs: 2000 }).request('eth_call').catch((e: unknown) => e);
    expect((e2 as RpcError).transient).toBe(false);

    const dead = new HttpTransport({ url: 'http://127.0.0.1:1/SECRETKEY', label: 'x', timeoutMs: 500 });
    const e3 = await dead.request('eth_blockNumber').catch((e: unknown) => e);
    expect((e3 as RpcError).transient).toBe(true);
    expect((e3 as RpcError).message).not.toContain('SECRETKEY');
  });

  it('redactUrl drops the path where API keys live', () => {
    expect(redactUrl('https://eth-mainnet.g.alchemy.com/v2/abcdef')).toBe('https://eth-mainnet.g.alchemy.com/…');
  });
});

describe('buildLiveRpc', () => {
  it('gives every provider a unique name even when URLs share a host, and never leaks keys', async () => {
    const { buildLiveRpc } = await import('../src/rpc/factory.js');
    const { demoConfig } = await import('./helpers.js');
    const cfg = demoConfig().sentinel;
    const same = { ...cfg, rpc: { ...cfg.rpc, primary: { http: 'http://h/p/KEY1' }, secondary: { http: 'http://h/s/KEY2' }, canary: { http: 'http://h/c/KEY3' } } };
    const live = buildLiveRpc(same, clock, silentLogger());
    const names = live.health.heads().map((h) => h.name);
    expect(new Set(names).size).toBe(3);
    expect(names.join()).not.toMatch(/KEY/);
    expect(live.primaryName).toBe('h');
  });
});
