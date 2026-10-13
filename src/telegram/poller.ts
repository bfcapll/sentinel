/** Long-poll getUpdates loops, one per bot, with the offset persisted so restarts never replay updates. */
import type { Logger } from '../log.js';
import type { Store } from '../store/db.js';
import type { Clock } from '../time.js';
import type { BotName, Gateway } from './api.js';
import type { UpdateHandler } from './commands.js';

export interface PollerOptions {
  store: Store;
  gateway: Gateway;
  handler: UpdateHandler;
  clock: Clock;
  log: Logger;
  /** Long-poll window handed to getUpdates. */
  pollTimeoutS?: number;
  /** Cap for the error backoff, ms. */
  maxBackoffMs?: number;
}

const BOTS: BotName[] = ['p0', 'p1', 'p2'];
export const offsetKey = (bot: BotName): string => `tg.offset.${bot}`;

export class UpdatePoller {
  private readonly o: PollerOptions;
  private abort: AbortController | null = null;
  private loops: Promise<void>[] = [];

  constructor(o: PollerOptions) {
    this.o = o;
  }

  get running(): boolean {
    return this.abort !== null;
  }

  start(): void {
    if (this.abort) return;
    const abort = new AbortController();
    this.abort = abort;
    this.loops = BOTS.map((bot) => this.loop(bot, abort.signal));
  }

  /** Aborts in-flight long polls and backoff sleeps, then waits for the loops to unwind. */
  async stop(): Promise<void> {
    const abort = this.abort;
    if (!abort) return;
    this.abort = null;
    abort.abort();
    await Promise.allSettled(this.loops);
    this.loops = [];
  }

  private readOffset(bot: BotName): number {
    const v = Number(this.o.store.repos.kv.get(offsetKey(bot)) ?? '0');
    return Number.isFinite(v) ? v : 0;
  }

  /** One fetch-and-handle round; exposed for deterministic tests. Returns updates handled. */
  async pollOnce(bot: BotName, timeoutS: number, signal?: AbortSignal): Promise<number> {
    const updates = await this.o.gateway[bot].getUpdates(this.readOffset(bot), timeoutS, signal);
    for (const u of updates) {
      try {
        await this.o.handler.handle(bot, u);
      } catch (e) {
        // A poison update must not wedge the loop; it is skipped (and logged) after this attempt.
        this.o.log.error({ bot, updateId: u.update_id, err: e instanceof Error ? e.message : String(e) }, 'telegram update handler failed');
      }
      // Persist after handling: at-least-once, and ACK is idempotent.
      this.o.store.repos.kv.set(offsetKey(bot), String(u.update_id + 1), this.o.clock.now());
    }
    return updates.length;
  }

  private async loop(bot: BotName, signal: AbortSignal): Promise<void> {
    let failures = 0;
    const maxBackoff = this.o.maxBackoffMs ?? 30_000;
    while (!signal.aborted) {
      try {
        await this.pollOnce(bot, this.o.pollTimeoutS ?? 25, signal);
        failures = 0;
      } catch (e) {
        if (signal.aborted) break;
        failures++;
        const delay = Math.min(maxBackoff, 1000 * 2 ** Math.min(failures - 1, 10));
        this.o.log.warn({ bot, failures, err: e instanceof Error ? e.message : String(e) }, 'getUpdates failed; backing off');
        await sleep(delay, signal);
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = (): void => {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}
