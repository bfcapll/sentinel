import type { Logger } from '../log.js';
import type { HeadSource } from '../rpc/ws.js';

export interface TrackerOptions {
  pollIntervalMs: number;
  /** Fall back to HTTP polling when the WS source has been silent this long. */
  wsSilenceMs: number;
}

export type TrackerMode = 'ws' | 'poll';

/**
 * Head tracker: WebSocket `newHeads` when healthy, HTTP polling as the fallback
 * (PLAN.md §3.1 chain/). Emits each new highest head exactly once; consumers
 * (the scheduler) derive the confirmed target block from it.
 */
export class BlockTracker {
  private head: number | null = null;
  private lastWsAt: number | null = null;
  private timer: NodeJS.Timeout | null = null;
  private polling = false;
  private stopped = true;

  constructor(
    private readonly pollHead: () => Promise<number>,
    private readonly ws: HeadSource | null,
    private readonly opts: TrackerOptions,
    private readonly onHead: (head: number, source: TrackerMode) => void,
    private readonly log: Logger,
    private readonly nowMs: () => number = Date.now,
  ) {}

  latest(): number | null {
    return this.head;
  }

  mode(): TrackerMode {
    if (this.ws && this.lastWsAt !== null && this.nowMs() - this.lastWsAt <= this.opts.wsSilenceMs) return 'ws';
    return 'poll';
  }

  start(): void {
    this.stopped = false;
    this.ws?.start(
      (n) => {
        this.lastWsAt = this.nowMs();
        this.observe(n, 'ws');
      },
      () => undefined,
    );
    // Poll once immediately so the service has a head before the first WS message.
    void this.pollOnce(true);
    this.timer = setInterval(() => void this.pollOnce(false), this.opts.pollIntervalMs);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.ws?.stop();
  }

  /** Visible for tests: one polling tick. */
  async pollOnce(force: boolean): Promise<void> {
    if (this.stopped || this.polling) return;
    if (!force && this.mode() === 'ws') return;
    this.polling = true;
    try {
      this.observe(await this.pollHead(), 'poll');
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'head poll failed');
    } finally {
      this.polling = false;
    }
  }

  private observe(n: number, source: TrackerMode): void {
    if (this.head !== null && n <= this.head) return;
    this.head = n;
    this.onHead(n, source);
  }
}
