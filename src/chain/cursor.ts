import type { Logger } from '../log.js';
import type { BlockHeader, ChainReader } from '../rpc/types.js';
import type { Store } from '../store/db.js';

export interface CursorPlan {
  /** First block of the log range to scan. */
  from: number;
  /** Target block T = head - confirmations; state is read at T. */
  to: number;
  header: BlockHeader;
  /** Set when a reorg was detected and the cursor was rewound. */
  reorg?: { detectedAt: number; rewoundTo: number; reason: string };
  /** Set when the gap exceeded the catch-up limit and log history was skipped. */
  skipped?: { fromBlock: number; toBlock: number };
}

export interface CursorOptions {
  chain: string;
  rescanBlocks: number;
  maxCatchupBlocks: number;
}

/**
 * Cursor + reorg planner (PLAN.md §3.4, §10 Phase 0).
 *
 * The cursor (last block whose cycle fully committed) lives in SQLite and is advanced in the
 * same transaction as the cycle's results, so a crash replays from the last committed cursor.
 * Reorg detection: the stored hash of the cursor block must still match the chain, and when the
 * next block is contiguous its parentHash must equal the cursor hash. On a mismatch the cursor
 * is rewound by `rescanBlocks` and the range re-scanned; alert dedupe by condition_key means a
 * re-observed condition never re-alerts.
 */
export class CursorPlanner {
  constructor(
    private readonly store: Store,
    private readonly reader: ChainReader,
    private readonly opts: CursorOptions,
    private readonly log: Logger,
  ) {}

  /** Returns null when the cursor is already at or past `target`. */
  async plan(target: number): Promise<CursorPlan | null> {
    const cursor = this.store.repos.cursor.get(this.opts.chain);
    const header = await this.reader.getBlock(target);

    if (!cursor) {
      return { from: target, to: target, header };
    }
    if (cursor.block >= target) return null;

    let reorg: CursorPlan['reorg'];
    let cursorBlock = cursor.block;

    const onChain = await this.reader.getBlock(cursor.block, { fresh: true });
    let reason: string | null = null;
    if (onChain.hash.toLowerCase() !== cursor.hash.toLowerCase()) {
      reason = `block ${cursor.block} hash changed (${short(cursor.hash)} -> ${short(onChain.hash)})`;
    } else if (header.number === cursor.block + 1 && header.parentHash.toLowerCase() !== cursor.hash.toLowerCase()) {
      reason = `block ${header.number} parentHash does not match cursor hash`;
    }

    if (reason) {
      const rewoundTo = Math.max(0, cursor.block - this.opts.rescanBlocks);
      this.reader.invalidate?.(rewoundTo);
      const anchor = await this.reader.getBlock(rewoundTo, { fresh: true });
      this.log.warn({ cursor: cursor.block, rewoundTo, reason }, 'reorg detected, rewinding cursor');
      this.store.tx(() => {
        this.store.repos.blockLog.deleteAbove(rewoundTo);
        this.store.repos.blockLog.put(anchor.number, anchor.hash, anchor.parentHash);
        this.store.repos.cursor.set(this.opts.chain, anchor.number, anchor.hash, Math.floor(Date.now() / 1000));
      });
      cursorBlock = rewoundTo;
      reorg = { detectedAt: cursor.block, rewoundTo, reason };
    }

    let from = cursorBlock + 1;
    let skipped: CursorPlan['skipped'];
    if (target - from + 1 > this.opts.maxCatchupBlocks) {
      const newFrom = target - this.opts.maxCatchupBlocks + 1;
      skipped = { fromBlock: from, toBlock: newFrom - 1 };
      this.log.warn(skipped, 'catch-up gap too large; skipping log history (state reads remain authoritative)');
      from = newFrom;
    }
    return { from, to: target, header, ...(reorg ? { reorg } : {}), ...(skipped ? { skipped } : {}) };
  }

  /** Write the cursor and block log. Call inside the cycle's transaction. */
  commit(header: BlockHeader, ts: number): void {
    this.store.repos.cursor.set(this.opts.chain, header.number, header.hash, ts);
    this.store.repos.blockLog.put(header.number, header.hash, header.parentHash);
    this.store.repos.blockLog.prune(64);
  }
}

const short = (h: string): string => `${h.slice(0, 10)}…`;
