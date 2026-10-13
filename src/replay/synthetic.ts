import {
  decodeFunctionData,
  encodeAbiParameters,
  encodeFunctionResult,
  keccak256,
  parseAbi,
  toBytes,
  type Hex as ViemHex,
} from 'viem';
import type { Address, Hex } from '../config/schema.js';
import { MULTICALL3 } from '../rpc/multicall.js';
import { RpcError, type RpcTransport } from '../rpc/types.js';

const MULTICALL_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);
const READ_ABI = parseAbi([
  'function balanceOf(address) view returns (uint256)',
  'function totalSupply() view returns (uint256)',
  'function totalAssets() view returns (uint256)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

export interface SyntheticScenario {
  /** Highest block the "node" knows about. */
  head: number;
  genesisTimestamp: number;
  blockTime: number;
  /** Storage writes: the value at a block is the latest entry with fromBlock <= block. */
  storage: Array<{ address: Address; slot: Hex; fromBlock: number; value: Hex }>;
  logs: Array<{ block: number; address: Address; topics: Hex[]; data: Hex; txHash: Hex }>;
  /** ERC-20 balances by token then holder. */
  balances?: Record<string, Record<string, Array<{ fromBlock: number; value: bigint }>>>;
  /** Optional hard reorg: from this block on, hashes use this salt. */
  reorg?: { fromBlock: number; salt: string };
}

const ZERO_WORD: Hex = `0x${'0'.repeat(64)}`;
const hex = (n: number): Hex => `0x${n.toString(16)}`;

/**
 * A scripted in-process "node" that answers exactly the JSON-RPC subset the pipeline uses
 * (blocks, storage, logs, Multicall3 eth_call). It makes fixtures reproducible without a network
 * and doubles as the synthetic-fixture source of PLAN.md §8.2 ("storage-slot write without an
 * Upgraded event", etc.).
 */
export class SyntheticChain implements RpcTransport {
  readonly label = 'synthetic';
  calls = 0;

  constructor(public scenario: SyntheticScenario) {}

  hashOf(n: number): Hex {
    const salt = this.scenario.reorg && n >= this.scenario.reorg.fromBlock ? this.scenario.reorg.salt : 'main';
    return keccak256(toBytes(`synthetic:${salt}:${n}`));
  }

  private header(n: number): Record<string, string> {
    return {
      number: hex(n),
      hash: this.hashOf(n),
      parentHash: this.hashOf(n - 1),
      timestamp: hex(this.scenario.genesisTimestamp + n * this.scenario.blockTime),
    };
  }

  private blockArg(tag: unknown): number {
    if (tag === 'latest') return this.scenario.head;
    if (typeof tag === 'string' && tag.startsWith('0x')) return Number.parseInt(tag, 16);
    throw new RpcError(`synthetic: unsupported block tag ${String(tag)}`, { transient: false });
  }

  private storageAt(address: string, slot: string, block: number): Hex {
    let best: { fromBlock: number; value: Hex } | undefined;
    for (const s of this.scenario.storage) {
      if (s.address.toLowerCase() !== address.toLowerCase() || s.slot.toLowerCase() !== slot.toLowerCase()) continue;
      if (s.fromBlock <= block && (!best || s.fromBlock >= best.fromBlock)) best = s;
    }
    return best?.value ?? ZERO_WORD;
  }

  private balance(token: string, holder: string, block: number): bigint {
    const rows = this.scenario.balances?.[token.toLowerCase()]?.[holder.toLowerCase()] ?? [];
    let v = 0n;
    let at = -1;
    for (const r of rows) {
      if (r.fromBlock <= block && r.fromBlock >= at) {
        v = r.value;
        at = r.fromBlock;
      }
    }
    return v;
  }

  private readCall(target: string, data: ViemHex, block: number): ViemHex {
    const d = decodeFunctionData({ abi: READ_ABI, data });
    switch (d.functionName) {
      case 'balanceOf':
        return encodeFunctionResult({ abi: READ_ABI, functionName: 'balanceOf', result: this.balance(target, d.args[0] as string, block) });
      case 'totalSupply':
        return encodeFunctionResult({ abi: READ_ABI, functionName: 'totalSupply', result: 10n ** 24n });
      case 'totalAssets':
        return encodeFunctionResult({ abi: READ_ABI, functionName: 'totalAssets', result: 10n ** 24n });
      case 'latestRoundData':
        return encodeFunctionResult({
          abi: READ_ABI,
          functionName: 'latestRoundData',
          result: [1n, 100_000_000n, 0n, BigInt(this.scenario.genesisTimestamp + block * this.scenario.blockTime), 1n],
        });
      default:
        throw new Error('unreachable');
    }
  }

  private ethCall(to: string, data: ViemHex, block: number): ViemHex {
    if (to.toLowerCase() !== MULTICALL3.toLowerCase()) throw new RpcError('synthetic: only Multicall3 eth_call is supported', { transient: false, code: 3 });
    const { args } = decodeFunctionData({ abi: MULTICALL_ABI, data });
    const calls = args[0] as ReadonlyArray<{ target: string; callData: ViemHex }>;
    const results = calls.map((c) => {
      try {
        return { success: true, returnData: this.readCall(c.target, c.callData, block) };
      } catch {
        return { success: false, returnData: '0x' as ViemHex };
      }
    });
    return encodeAbiParameters(
      [{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }],
      [results],
    );
  }

  async request(method: string, params: readonly unknown[] = []): Promise<unknown> {
    this.calls++;
    switch (method) {
      case 'eth_chainId':
        return '0x1';
      case 'eth_blockNumber':
        return hex(this.scenario.head);
      case 'eth_getBlockByNumber': {
        const n = this.blockArg(params[0]);
        if (n > this.scenario.head || n < 0) return null;
        return this.header(n);
      }
      case 'eth_getStorageAt':
        return this.storageAt(params[0] as string, params[1] as string, this.blockArg(params[2]));
      case 'eth_getLogs': {
        const f = params[0] as { address?: string | string[]; fromBlock: string; toBlock: string; topics?: Array<string[] | string | null> };
        const from = this.blockArg(f.fromBlock);
        const to = this.blockArg(f.toBlock);
        const addrs = (Array.isArray(f.address) ? f.address : f.address ? [f.address] : []).map((a) => a.toLowerCase());
        const t0 = f.topics?.[0];
        const wanted = t0 ? (Array.isArray(t0) ? t0 : [t0]).map((t) => t.toLowerCase()) : null;
        return this.scenario.logs
          .filter((l) => l.block >= from && l.block <= to)
          .filter((l) => addrs.length === 0 || addrs.includes(l.address.toLowerCase()))
          .filter((l) => !wanted || wanted.includes((l.topics[0] ?? '').toLowerCase()))
          .map((l, i) => ({
            address: l.address,
            topics: l.topics,
            data: l.data,
            blockNumber: hex(l.block),
            blockHash: this.hashOf(l.block),
            transactionHash: l.txHash,
            transactionIndex: '0x0',
            logIndex: hex(i),
            removed: false,
          }));
      }
      case 'eth_call': {
        const call = params[0] as { to: string; data: ViemHex };
        return this.ethCall(call.to, call.data, this.blockArg(params[1]));
      }
      default:
        throw new RpcError(`synthetic: unsupported method ${method}`, { transient: false, code: -32601 });
    }
  }
}
