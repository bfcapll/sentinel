import type { Address, Hex } from '../config/schema.js';
import type { Logger } from '../log.js';
import type { Clock } from '../time.js';
import type { RpcHealth } from './health.js';
import { MULTICALL3, decodeAggregate3, encodeAggregate3, encodeRead } from './multicall.js';
import {
  RpcError,
  type BlockHeader,
  type ChainReader,
  type LogQuery,
  type ProviderRole,
  type ReadCall,
  type ReadResult,
  type RpcLog,
  type RpcTransport,
} from './types.js';

export interface ProviderEntry {
  name: string;
  role: ProviderRole;
  transport: RpcTransport;
}

export interface RpcClientOptions {
  providers: ProviderEntry[];
  health: RpcHealth;
  clock: Clock;
  log: Logger;
  /** Max inner calls per Multicall3 eth_call (PLAN.md §3.4: ~60). */
  multicallBatch?: number;
  /** Max block span per eth_getLogs request (halved adaptively on provider limits). */
  logChunk?: number;
  /** How many recent blocks' worth of request cache to keep. */
  cacheBlocks?: number;
}

const toHexNum = (n: number): Hex => `0x${n.toString(16)}`;
const fromHexNum = (h: unknown): number => {
  if (typeof h !== 'string') throw new RpcError(`expected hex quantity, got ${typeof h}`, { transient: true });
  return Number.parseInt(h, 16);
};

interface RawHeader {
  number: string;
  hash: Hex;
  parentHash: Hex;
  timestamp: string;
}

interface RawLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: string;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: string;
  logIndex: string;
  removed?: boolean;
}

/**
 * Dual-provider RPC client (PLAN.md §3.2).
 *
 *  - reads go to the health-selected active provider and fail over to the other on transient errors
 *  - every pinned-block request is cached per block and de-duplicated while in flight, so the
 *    watchers and the position reader share one request for the same (method, params, block)
 *  - contract reads are batched through Multicall3
 *  - the dRPC canary is never used for reads: it only answers eth_blockNumber for the health rules
 */
export class RpcClient implements ChainReader {
  private readonly byName = new Map<string, ProviderEntry>();
  private readonly cache = new Map<number, Map<string, Promise<unknown>>>();
  private readonly multicallBatch: number;
  private readonly logChunk: number;
  private readonly cacheBlocks: number;

  constructor(private readonly o: RpcClientOptions) {
    for (const p of o.providers) this.byName.set(p.name, p);
    this.multicallBatch = o.multicallBatch ?? 60;
    this.logChunk = o.logChunk ?? 500;
    this.cacheBlocks = o.cacheBlocks ?? 4;
  }

  get health(): RpcHealth {
    return this.o.health;
  }

  /** Providers eligible for reads, active first. */
  private readCandidates(): ProviderEntry[] {
    const active = this.o.health.evaluate(this.o.clock.now()).active;
    const readers = this.o.providers.filter((p) => p.role !== 'canary');
    return [...readers].sort((a, b) => Number(b.name === active) - Number(a.name === active));
  }

  /** Active provider name (for status output). */
  activeProvider(): string {
    return this.o.health.evaluate(this.o.clock.now()).active;
  }

  private async send(method: string, params: readonly unknown[]): Promise<{ value: unknown; provider: string }> {
    const errors: string[] = [];
    for (const p of this.readCandidates()) {
      try {
        const value = await p.transport.request(method, params);
        return { value, provider: p.name };
      } catch (e) {
        const err = e instanceof RpcError ? e : new RpcError(String(e), { transient: true, provider: p.name });
        if (!err.transient) throw err;
        this.o.health.recordError(p.name, this.o.clock.now());
        this.o.log.warn({ provider: p.name, method, err: err.message }, 'rpc request failed, trying next provider');
        errors.push(`${p.name}: ${err.message}`);
      }
    }
    throw new RpcError(`all providers failed for ${method}: ${errors.join(' | ')}`, { transient: true, method });
  }

  /** Per-block memoised request. Rejected promises are evicted so a retry can succeed. */
  private cached<T>(block: number, key: string, fn: () => Promise<T>): Promise<T> {
    let bucket = this.cache.get(block);
    if (!bucket) {
      bucket = new Map();
      this.cache.set(block, bucket);
      this.sweep();
    }
    const hit = bucket.get(key);
    if (hit) return hit as Promise<T>;
    const p = fn();
    bucket.set(key, p);
    p.catch(() => bucket!.delete(key));
    return p;
  }

  private sweep(): void {
    if (this.cache.size <= this.cacheBlocks) return;
    const newest = Math.max(...this.cache.keys());
    for (const b of this.cache.keys()) if (b <= newest - this.cacheBlocks) this.cache.delete(b);
  }

  /** Cache entry count, for tests. */
  cacheSize(): number {
    let n = 0;
    for (const b of this.cache.values()) n += b.size;
    return n;
  }

  /* ---------------------------------------------------------------- ChainReader */

  async getBlockNumber(): Promise<number> {
    const { value, provider } = await this.send('eth_blockNumber', []);
    const n = fromHexNum(value);
    this.o.health.observeHead(provider, n, this.o.clock.now());
    return n;
  }

  invalidate(fromBlock: number): void {
    for (const b of [...this.cache.keys()]) if (b >= fromBlock) this.cache.delete(b);
  }

  async getBlock(block: number | 'latest', opts: { fresh?: boolean } = {}): Promise<BlockHeader> {
    const fetchIt = async (): Promise<BlockHeader> => {
      const { value } = await this.send('eth_getBlockByNumber', [block === 'latest' ? 'latest' : toHexNum(block), false]);
      const h = value as RawHeader | null;
      if (!h) throw new RpcError(`block ${block} not found`, { transient: true, method: 'eth_getBlockByNumber' });
      return { number: fromHexNum(h.number), hash: h.hash, parentHash: h.parentHash, timestamp: fromHexNum(h.timestamp) };
    };
    if (block === 'latest') return fetchIt();
    if (opts.fresh) {
      this.cache.get(block)?.delete('header');
    }
    return this.cached(block, 'header', fetchIt);
  }

  getStorageAt(address: Address, slot: Hex, block: number): Promise<Hex> {
    return this.cached(block, `slot|${address.toLowerCase()}|${slot}`, async () => {
      const { value } = await this.send('eth_getStorageAt', [address, slot, toHexNum(block)]);
      return value as Hex;
    });
  }

  async multicall(calls: ReadCall[], block: number): Promise<ReadResult[]> {
    const results: Array<Promise<ReadResult>> = [];
    const pending: Array<{ call: ReadCall; key: string; resolve: (r: ReadResult) => void; reject: (e: unknown) => void }> = [];

    for (const call of calls) {
      const key = `call|${call.address.toLowerCase()}|${encodeRead(call)}`;
      let bucket = this.cache.get(block);
      if (!bucket) {
        bucket = new Map();
        this.cache.set(block, bucket);
        this.sweep();
      }
      const hit = bucket.get(key);
      if (hit) {
        results.push(hit as Promise<ReadResult>);
        continue;
      }
      let resolve!: (r: ReadResult) => void;
      let reject!: (e: unknown) => void;
      const p = new Promise<ReadResult>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      p.catch(() => bucket!.delete(key));
      bucket.set(key, p);
      results.push(p);
      pending.push({ call, key, resolve, reject });
    }

    for (let i = 0; i < pending.length; i += this.multicallBatch) {
      const chunk = pending.slice(i, i + this.multicallBatch);
      void this.runChunk(chunk, block);
    }
    return Promise.all(results);
  }

  private async runChunk(
    chunk: Array<{ call: ReadCall; resolve: (r: ReadResult) => void; reject: (e: unknown) => void }>,
    block: number,
  ): Promise<void> {
    const calls = chunk.map((c) => c.call);
    try {
      const { value } = await this.send('eth_call', [{ to: MULTICALL3, data: encodeAggregate3(calls) }, toHexNum(block)]);
      const decoded = decodeAggregate3(calls, value as Hex);
      chunk.forEach((c, i) => c.resolve(decoded[i] as ReadResult));
    } catch (e) {
      for (const c of chunk) c.reject(e);
    }
  }

  async getLogs(q: LogQuery): Promise<RpcLog[]> {
    if (q.addresses.length === 0 || q.toBlock < q.fromBlock) return [];
    const out: RpcLog[] = [];
    let from = q.fromBlock;
    let span = this.logChunk;
    while (from <= q.toBlock) {
      const to = Math.min(q.toBlock, from + span - 1);
      try {
        out.push(...(await this.getLogsOnce({ ...q, fromBlock: from, toBlock: to })));
        from = to + 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (span > 1 && /limit|too many|more than|exceed|range|size/i.test(msg)) {
          span = Math.max(1, Math.floor(span / 2));
          this.o.log.warn({ span }, 'eth_getLogs range too large for provider, halving');
          continue;
        }
        throw e;
      }
    }
    return out.filter((l) => !l.removed);
  }

  private getLogsOnce(q: LogQuery): Promise<RpcLog[]> {
    const filter: Record<string, unknown> = {
      address: [...new Set(q.addresses)],
      fromBlock: toHexNum(q.fromBlock),
      toBlock: toHexNum(q.toBlock),
    };
    if (q.topic0 && q.topic0.length > 0) filter['topics'] = [q.topic0];
    const key = `logs|${JSON.stringify(filter)}`;
    return this.cached(q.toBlock, key, async () => {
      const { value } = await this.send('eth_getLogs', [filter]);
      return (value as RawLog[]).map((l) => ({
        address: l.address,
        topics: l.topics,
        data: l.data,
        blockNumber: fromHexNum(l.blockNumber),
        blockHash: l.blockHash,
        transactionHash: l.transactionHash,
        transactionIndex: fromHexNum(l.transactionIndex),
        logIndex: fromHexNum(l.logIndex),
        removed: !!l.removed,
      }));
    });
  }

  /* ---------------------------------------------------------------- health feed */

  /**
   * Ask every provider (including the canary) for its head and feed the health rules.
   * Independent of the read path so a broken primary cannot hide itself.
   */
  async pollHeads(): Promise<Array<{ name: string; head: number | null; error?: string }>> {
    const now = this.o.clock.now();
    return Promise.all(
      this.o.providers.map(async (p) => {
        try {
          const head = fromHexNum(await p.transport.request('eth_blockNumber', []));
          this.o.health.observeHead(p.name, head, now);
          return { name: p.name, head };
        } catch (e) {
          this.o.health.recordError(p.name, now);
          return { name: p.name, head: null, error: e instanceof Error ? e.message : String(e) };
        }
      }),
    );
  }
}
