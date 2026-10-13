import type { Abi } from 'viem';
import type { Address, Hex, Holding } from '../config/schema.js';
import type { LoadedConfig } from '../config/loader.js';
import type { ReadResult, RpcLog } from '../rpc/types.js';
import type { ThresholdKey, ThresholdSpec } from '../rules/defaults.js';
import type { Sample } from '../rules/types.js';

/** A contract read (via Multicall3) or a raw storage-slot read, executed at the pinned block. */
export type StateRead =
  | { id: string; kind: 'call'; address: Address; abi: Abi; functionName: string; args?: readonly unknown[] }
  | { id: string; kind: 'storage'; address: Address; slot: Hex };

export interface LogRequest {
  address: Address;
  /** topic0 any-of; omitted = every event from this address. */
  topics?: Hex[];
}

export interface WatchContext {
  holding: Holding;
  config: LoadedConfig;
  threshold(key: ThresholdKey): ThresholdSpec;
}

export interface WatchPlan {
  reads: StateRead[];
  logs: LogRequest[];
}

export interface ObservationDraft {
  kind: string;
  payload: unknown;
  txHash?: Hex;
  logIndex?: number;
  block: number;
}

export interface SnapshotWrite {
  /** Full key, conventionally `holding/watcher/field`. */
  key: string;
  value: unknown;
  /** When set, also appended to snapshot_history for windows/persistence rules. */
  numeric?: number;
}

export interface WatcherOutput {
  samples: Sample[];
  observations: ObservationDraft[];
  snapshots: SnapshotWrite[];
}

export interface FoldInput {
  ctx: WatchContext;
  block: { number: number; timestamp: number };
  /** Unix seconds for this evaluation (wall clock live, block timestamp in replay). */
  ts: number;
  /** Results of this watcher's own `plan().reads`, keyed by the read id it declared. */
  reads: ReadMap;
  /** Logs in this cycle's range from the addresses this watcher asked for. */
  logs: RpcLog[];
  /** Snapshot values from before this cycle. */
  prev: (key: string) => unknown;
}

export interface ReadMap {
  get(id: string): ReadResult | undefined;
  /** Value or throw: use for reads the watcher cannot work without. */
  require<T = unknown>(id: string): T;
}

/**
 * One module per signal family (PLAN.md §3.1). `plan` declares what to read; `fold` is a pure
 * function from (reads, logs, prior snapshots) to samples. Watcher code contains no protocol
 * addresses: every address comes from the holding's config.
 */
export interface Watcher {
  readonly name: string;
  /** P0-class watchers (proxy, safe, pause) escalate to OPS P0 when erroring for 10 minutes. */
  readonly p0Class: boolean;
  appliesTo(holding: Holding): boolean;
  plan(ctx: WatchContext): WatchPlan;
  fold(input: FoldInput): WatcherOutput;
}
