import type { Address, Holding } from './config/schema.js';
import type { LoadedConfig } from './config/loader.js';
import { CursorPlanner } from './chain/cursor.js';
import { routeTransitions } from './alerts/router.js';
import { WatcherErrors } from './health/watcher-errors.js';
import type { Pinger } from './health/healthchecks.js';
import type { StatusProvider, StatusSnapshot } from './health/status.js';
import type { Logger } from './log.js';
import {
  computeExitPath,
  computePosition,
  planPosition,
  type ExitPath,
  type PositionOverride,
  type PositionSummary,
} from './position/index.js';
import type { HealthEvaluation } from './rpc/health.js';
import { rpcOpsSamples } from './rpc/ops.js';
import { RpcError, type BlockHeader, type ChainReader, type ReadCall, type ReadResult, type RpcLog } from './rpc/types.js';
import { evaluate } from './rules/engine.js';
import type { ConditionState, Sample, Transition } from './rules/types.js';
import type { Store } from './store/db.js';
import { systemClock, type Clock } from './time.js';
import { watchersFor, ALL_WATCHERS } from './watchers/registry.js';
import type {
  ObservationDraft,
  ReadMap,
  SnapshotWrite,
  StateRead,
  WatchContext,
  WatchPlan,
  Watcher,
} from './watchers/types.js';

export interface SchedulerOptions {
  config: LoadedConfig;
  store: Store;
  reader: ChainReader;
  log: Logger;
  /** Wall clock for live runs. */
  clock?: Clock;
  /** Replay: use the target block's timestamp as "now" so cooldowns/persistence behave as they did then. */
  useBlockTime?: boolean;
  watchers?: readonly Watcher[];
  pinger?: Pinger;
  position?: PositionOverride;
  /** Restrict to these holding ids (replay --holding). */
  holdingFilter?: string[];
  /** Live only: RPC health feed for ops conditions and /status. */
  rpcHealth?: () => HealthEvaluation;
  headBlock?: () => number | null;
  /** Hook after a cycle commits (replay uses it to flush the Telegram sink). */
  onCommitted?: (r: CycleResult) => void | Promise<void>;
}

export interface CycleResult {
  block: number;
  ts: number;
  durationMs: number;
  transitions: Transition[];
  alerts: Array<{ id: number; tier: string; key: string }>;
  reorg?: { detectedAt: number; rewoundTo: number; reason: string };
  watcherErrors: string[];
}

interface Job {
  holding: Holding;
  watcher: Watcher;
  ctx: WatchContext;
  plan: WatchPlan;
  prefix: string;
}

const PRUNE_EVERY_S = 3600;
const DAY = 86_400;

/**
 * The one scheduler code path: live (driven by new heads) and replay (driven by a block loop with
 * a fixture-backed reader) both call `runAtBlock`. See PLAN.md §3.4 for the step numbering.
 */
export class Scheduler implements StatusProvider {
  readonly watcherErrors = new WatcherErrors();
  private readonly cursor: CursorPlanner;
  private readonly clock: Clock;
  private readonly watchers: readonly Watcher[];
  private readonly startedAt: number;
  private cycleTimes: number[] = [];
  private lastCycle: StatusSnapshot['lastCycle'] = null;
  private processedBlock: number | null = null;
  private latestPositions = new Map<string, PositionSummary>();
  private latestExit = new Map<string, ExitPath>();
  private running = false;
  private pendingHead: number | null = null;

  constructor(private readonly o: SchedulerOptions) {
    this.clock = o.clock ?? systemClock;
    this.watchers = o.watchers ?? ALL_WATCHERS;
    this.startedAt = this.clock.now();
    const rpc = o.config.sentinel.rpc;
    this.cursor = new CursorPlanner(
      o.store,
      o.reader,
      { chain: o.config.sentinel.chain, rescanBlocks: rpc.reorg_rescan_blocks, maxCatchupBlocks: o.config.sentinel.cycle.max_catchup_blocks },
      o.log,
    );
    for (const w of this.watchers) this.watcherErrors.register(w.name);
    this.processedBlock = o.store.repos.cursor.get(o.config.sentinel.chain)?.block ?? null;
  }

  /* ------------------------------------------------------------------ live driving */

  /** Live entry: called for every new head; coalesces bursts so cycles never overlap. */
  async onHead(head: number): Promise<void> {
    this.pendingHead = Math.max(this.pendingHead ?? 0, head);
    if (this.running) return;
    this.running = true;
    try {
      while (this.pendingHead !== null) {
        const h = this.pendingHead;
        this.pendingHead = null;
        const target = h - this.o.config.sentinel.rpc.confirmations;
        try {
          await this.runAtBlock(target);
        } catch (e) {
          // Infrastructure failure: nothing committed, no heartbeat, cursor unchanged. The next
          // head retries from the same cursor; the RPC health rules raise the alert.
          this.o.log.error({ err: (e as Error).message, target }, 'cycle failed');
        }
      }
    } finally {
      this.running = false;
    }
  }

  /* ------------------------------------------------------------------ the cycle */

  async runAtBlock(target: number): Promise<CycleResult | null> {
    const t0 = Date.now();
    const plan = await this.cursor.plan(target);
    if (!plan) return null;
    const header = plan.header;
    const ts = this.o.useBlockTime ? header.timestamp : this.clock.now();

    const holdings = this.o.config.holdings.filter(
      (h) => h.enabled && (!this.o.holdingFilter || this.o.holdingFilter.includes(h.id)),
    );

    /* 2. gather reads */
    const jobs: Job[] = [];
    const positionReads = new Map<string, StateRead[]>();
    for (const holding of holdings) {
      const ctx: WatchContext = {
        holding,
        config: this.o.config,
        threshold: (k) => this.o.config.threshold(holding, k),
      };
      for (const watcher of watchersFor(holding, this.watchers)) {
        jobs.push({ holding, watcher, ctx, plan: watcher.plan(ctx), prefix: `${holding.id}|${watcher.name}|` });
      }
      positionReads.set(holding.id, planPosition(holding, this.o.config, this.o.position ?? {}));
    }

    const all: Array<{ fullId: string; read: StateRead }> = [];
    for (const j of jobs) for (const r of j.plan.reads) all.push({ fullId: j.prefix + r.id, read: r });
    for (const [hid, reads] of positionReads) for (const r of reads) all.push({ fullId: `${hid}|position|${r.id}`, read: r });
    const results = await this.executeReads(all, header.number);

    /* 3. logs for [from, to] */
    const logs = await this.fetchLogs(jobs, plan.from, plan.to);

    /* 4. fold */
    const samples: Sample[] = [];
    const observations: Array<ObservationDraft & { holding: string; watcher: string }> = [];
    const snapshotWrites: SnapshotWrite[] = [];
    const failed = new Set<string>();
    const ran = new Set<string>();
    const prev = (key: string): unknown => this.o.store.repos.snapshot.get(key)?.value;

    for (const j of jobs) {
      ran.add(j.watcher.name);
      try {
        const reads = readMap(j.prefix, j.plan.reads, results);
        const out = j.watcher.fold({
          ctx: j.ctx,
          block: { number: header.number, timestamp: header.timestamp },
          ts,
          reads,
          logs: logsFor(j.plan, logs),
          prev,
        });
        samples.push(...out.samples);
        for (const ob of out.observations) observations.push({ ...ob, holding: j.holding.id, watcher: j.watcher.name });
        snapshotWrites.push(...out.snapshots);
        // Persist every raw state read (PLAN.md §4 `snapshot`: latest value of every polled key).
        for (const r of j.plan.reads) {
          const v = results.get(j.prefix + r.id);
          if (v?.ok) snapshotWrites.push({ key: `${j.holding.id}/${j.watcher.name}/read/${r.id}`, value: v.value });
        }
      } catch (e) {
        failed.add(j.watcher.name);
        this.watcherErrors.recordError(j.watcher.name, ts, e);
        this.o.log.error({ watcher: j.watcher.name, holding: j.holding.id, err: (e as Error).message }, 'watcher failed');
      }
    }
    for (const name of ran) if (!failed.has(name)) this.watcherErrors.recordOk(name, ts);

    /* 5. position */
    const positions = new Map<string, PositionSummary>();
    for (const holding of holdings) {
      try {
        const reads = readMap(`${holding.id}|position|`, positionReads.get(holding.id) ?? [], results);
        positions.set(holding.id, computePosition(holding, this.o.config, reads, this.o.position ?? {}));
      } catch (e) {
        this.o.log.error({ holding: holding.id, err: (e as Error).message }, 'position read failed');
      }
    }

    /* 6-7. rules + alerts + cursor: one SQLite transaction */
    samples.push(...this.watcherErrors.samples(ts, this.o.config.threshold(undefined, 'ops.watcher_error')));
    const committed = this.o.store.tx(() => {
      const repos = this.o.store.repos;
      const prior = repos.condition.all();
      const ev = evaluate(prior, samples, { block: header.number, ts });
      for (const s of ev.states) repos.condition.upsert(s);
      const merged = new Map<string, ConditionState>(prior);
      for (const s of ev.states) merged.set(s.key, s);

      const exitPaths = new Map<string, ExitPath>();
      for (const h of holdings) exitPaths.set(h.id, computeExitPath(h.id, merged.values()));

      const routed = routeTransitions({
        store: this.o.store,
        config: this.o.config,
        transitions: ev.transitions,
        positions,
        exitPaths,
        at: { block: header.number, ts },
      });

      for (const w of snapshotWrites) {
        repos.snapshot.put(w.key, w.value, header.number, ts);
        if (w.numeric !== undefined) repos.snapshot.addHistory(w.key, w.numeric, header.number, ts);
      }
      for (const [hid, p] of positions) {
        repos.snapshot.put(`${hid}/position/summary`, summarise(p), header.number, ts);
        if (p.exposureUsd !== null) repos.snapshot.addHistory(`${hid}/position/exposure_usd`, p.exposureUsd, header.number, ts);
      }
      for (const ob of observations) {
        repos.observation.insert({ ...ob, ts });
      }
      this.cursor.commit(header, ts);
      this.maybePrune(ts);
      return { transitions: ev.transitions, alerts: routed.created, exitPaths };
    });

    this.latestPositions = positions;
    this.latestExit = committed.exitPaths;
    this.processedBlock = header.number;
    const durationMs = Date.now() - t0;
    this.lastCycle = { block: header.number, durationMs, at: ts };
    this.cycleTimes.push(ts);
    this.cycleTimes = this.cycleTimes.filter((t) => t > ts - DAY);

    const result: CycleResult = {
      block: header.number,
      ts,
      durationMs,
      transitions: committed.transitions,
      alerts: committed.alerts,
      ...(plan.reorg ? { reorg: plan.reorg } : {}),
      watcherErrors: [...failed],
    };
    for (const a of committed.alerts) this.o.log.warn({ alert: a, block: header.number }, 'alert created');

    /* 8. heartbeat: only after the whole cycle committed */
    if (this.o.pinger) await this.o.pinger.ping(this.clock.now());
    await this.o.onCommitted?.(result);
    return result;
  }

  /* ------------------------------------------------------------------ ops conditions */

  /** Independent of blocks: runs on a timer so a chain stall still alerts. */
  opsTick(): void {
    const now = this.clock.now();
    const samples: Sample[] = [...this.watcherErrors.samples(now, this.o.config.threshold(undefined, 'ops.watcher_error'))];
    if (this.o.rpcHealth) samples.push(...rpcOpsSamples(this.o.rpcHealth()));
    this.o.store.tx(() => {
      const repos = this.o.store.repos;
      const ev = evaluate(repos.condition.all(), samples, { block: this.processedBlock ?? 0, ts: now });
      for (const s of ev.states) repos.condition.upsert(s);
      routeTransitions({
        store: this.o.store,
        config: this.o.config,
        transitions: ev.transitions,
        positions: this.latestPositions,
        exitPaths: this.latestExit,
        at: { block: this.processedBlock ?? 0, ts: now },
      });
      if (this.o.rpcHealth) {
        const h = this.o.rpcHealth();
        for (const p of h.providers) {
          repos.rpcHealth.upsert({ provider: p.name, head: p.head, lag: p.lagBlocks, errors1m: p.errors1m, ts: now });
        }
      }
    });
  }

  /* ------------------------------------------------------------------ status */

  snapshot(): StatusSnapshot {
    const now = this.clock.now();
    const health = this.o.rpcHealth?.();
    return {
      now,
      headBlock: this.o.headBlock?.() ?? null,
      processedBlock: this.processedBlock,
      providers: (health?.providers ?? []).map((p) => ({
        name: p.name,
        role: p.role,
        head: p.head,
        lagBlocks: p.lagBlocks,
        errors1m: p.errors1m,
        active: health?.active === p.name,
      })),
      lastCycle: this.lastCycle,
      uptimeS: now - this.startedAt,
      cyclesLast24h: this.cycleTimes.filter((t) => t > now - DAY).length,
      holdings: this.o.config.holdings
        .filter((h) => h.enabled)
        .map((h) => ({
          id: h.id,
          exposureUsd: this.latestPositions.get(h.id)?.exposureUsd ?? null,
          exitPathOpen: this.latestExit.get(h.id)?.open ?? true,
          exitPathReason: this.latestExit.get(h.id)?.reason ?? 'no cycle has completed yet',
          watchers: watchersFor(h, this.watchers).map((w) => w.name),
        })),
      watchers: this.watcherErrors.snapshot(),
      lastHealthcheckPingAt: this.o.pinger?.lastPingAt() ?? null,
    };
  }

  /* ------------------------------------------------------------------ internals */

  private async executeReads(all: Array<{ fullId: string; read: StateRead }>, block: number): Promise<Map<string, ReadResult>> {
    const out = new Map<string, ReadResult>();
    const calls: Array<{ id: string; call: ReadCall }> = [];
    const storage: Array<{ id: string; address: Address; slot: StateRead & { kind: 'storage' } }> = [];
    for (const { fullId, read } of all) {
      if (read.kind === 'call') {
        calls.push({ id: fullId, call: { address: read.address, abi: read.abi, functionName: read.functionName, args: read.args } });
      } else storage.push({ id: fullId, address: read.address, slot: read });
    }
    const [callResults, storageResults] = await Promise.all([
      calls.length ? this.o.reader.multicall(calls.map((c) => c.call), block) : Promise.resolve([] as ReadResult[]),
      Promise.all(
        storage.map(async (s): Promise<ReadResult> => {
          try {
            return { ok: true, value: await this.o.reader.getStorageAt(s.address, s.slot.slot, block) };
          } catch (e) {
            // Deterministic failures belong to the watcher; transient ones fail the whole cycle.
            if (e instanceof RpcError && !e.transient) return { ok: false, error: e.message };
            throw e;
          }
        }),
      ),
    ]);
    calls.forEach((c, i) => out.set(c.id, callResults[i] as ReadResult));
    storage.forEach((s, i) => out.set(s.id, storageResults[i] as ReadResult));
    return out;
  }

  private async fetchLogs(jobs: Job[], from: number, to: number): Promise<RpcLog[]> {
    const addresses = new Set<Address>();
    const topics = new Set<string>();
    let unfiltered = false;
    for (const j of jobs) {
      for (const l of j.plan.logs) {
        addresses.add(l.address);
        if (!l.topics?.length) unfiltered = true;
        else l.topics.forEach((t) => topics.add(t.toLowerCase()));
      }
    }
    if (addresses.size === 0) return [];
    return this.o.reader.getLogs({
      addresses: [...addresses],
      ...(unfiltered ? {} : { topic0: [...topics] as `0x${string}`[] }),
      fromBlock: from,
      toBlock: to,
    });
  }

  private maybePrune(ts: number): void {
    const repos = this.o.store.repos;
    const last = Number(repos.kv.get('prune.last') ?? 0);
    if (ts - last < PRUNE_EVERY_S) return;
    repos.snapshot.pruneHistory(ts - 30 * DAY);
    repos.observation.prune(ts - 90 * DAY);
    repos.kv.set('prune.last', String(ts), ts);
  }
}

function readMap(prefix: string, reads: StateRead[], results: Map<string, ReadResult>): ReadMap {
  const ids = new Set(reads.map((r) => r.id));
  return {
    get: (id) => (ids.has(id) ? results.get(prefix + id) : undefined),
    require<T>(id: string): T {
      const r = ids.has(id) ? results.get(prefix + id) : undefined;
      if (!r) throw new Error(`read "${id}" was not planned`);
      if (!r.ok) throw new Error(`read "${id}" failed: ${r.error}`);
      return r.value as T;
    },
  };
}

function logsFor(plan: WatchPlan, logs: RpcLog[]): RpcLog[] {
  if (plan.logs.length === 0) return [];
  return logs.filter((l) =>
    plan.logs.some(
      (req) =>
        req.address.toLowerCase() === l.address.toLowerCase() &&
        (!req.topics?.length || req.topics.some((t) => t.toLowerCase() === l.topics[0]?.toLowerCase())),
    ),
  );
}

function summarise(p: PositionSummary): unknown {
  return {
    exposureUsd: p.exposureUsd,
    amount: p.amount,
    price: p.price,
    exitSizeUsd: p.exitSizeUsd,
    note: p.note,
    warnings: p.warnings,
    wallets: p.wallets.map((w) => ({ label: w.label, address: w.address, balance: w.balance.toString() })),
  };
}

export type { BlockHeader };
