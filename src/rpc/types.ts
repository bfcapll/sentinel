import type { Abi } from 'viem';
import type { Address, Hex } from '../config/schema.js';

/** Raw JSON-RPC request function. Everything below (HTTP, recorder, fixtures) implements this. */
export interface RpcTransport {
  request(method: string, params?: readonly unknown[]): Promise<unknown>;
  /** Short label used in logs and fixtures. */
  readonly label: string;
}

export type ProviderRole = 'primary' | 'secondary' | 'canary';

export interface BlockHeader {
  number: number;
  hash: Hex;
  parentHash: Hex;
  /** Unix seconds. */
  timestamp: number;
}

/** One contract read, executed through Multicall3 at a pinned block. */
export interface ReadCall {
  address: Address;
  abi: Abi;
  functionName: string;
  args?: readonly unknown[];
}

export type ReadResult = { ok: true; value: unknown } | { ok: false; error: string };

export interface LogQuery {
  addresses: Address[];
  /** topic0 any-of filter; omitted = all topics. */
  topic0?: Hex[];
  fromBlock: number;
  toBlock: number;
}

export interface RpcLog {
  address: Address;
  topics: Hex[];
  data: Hex;
  blockNumber: number;
  blockHash: Hex;
  transactionHash: Hex;
  transactionIndex: number;
  logIndex: number;
  removed: boolean;
}

/**
 * Pinned-block reads. Watchers, position and the cycle only ever see this interface, so the
 * live client and the replay harness (fixtures) run exactly the same code (PLAN.md §8.1).
 */
export interface ChainReader {
  getBlock(block: number | 'latest'): Promise<BlockHeader>;
  getBlockNumber(): Promise<number>;
  getStorageAt(address: Address, slot: Hex, block: number): Promise<Hex>;
  multicall(calls: ReadCall[], block: number): Promise<ReadResult[]>;
  getLogs(query: LogQuery): Promise<RpcLog[]>;
}

/** Transient failures are worth retrying on another provider; deterministic ones (reverts) are not. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly opts: { transient: boolean; code?: number; provider?: string; method?: string },
  ) {
    super(message);
    this.name = 'RpcError';
  }
  get transient(): boolean {
    return this.opts.transient;
  }
}
