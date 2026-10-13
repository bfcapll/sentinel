import type { Logger } from '../log.js';

export interface Pinger {
  /** Called after every fully committed cycle. Must never throw. */
  ping(nowS: number): Promise<void>;
  lastPingAt(): number | null;
}

export interface HealthchecksOptions {
  url: string;
  /** Don't ping more often than this (Healthchecks.io rate-limits pings per check). */
  minIntervalS: number;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

/**
 * Dead-man's switch (PLAN.md §3.4 step 8): the ping is sent only after a cycle fully committed,
 * so a wedged or crashed process stops pinging and Healthchecks.io alerts through its own channel.
 */
export class HealthchecksPinger implements Pinger {
  private last: number | null = null;
  private lastAttempt = 0;
  private inFlight = false;
  private readonly doFetch: typeof fetch;

  constructor(
    private readonly o: HealthchecksOptions,
    private readonly log: Logger,
  ) {
    this.doFetch = o.fetchImpl ?? fetch;
  }

  lastPingAt(): number | null {
    return this.last;
  }

  async ping(nowS: number): Promise<void> {
    if (this.inFlight || nowS - this.lastAttempt < this.o.minIntervalS) return;
    this.inFlight = true;
    this.lastAttempt = nowS;
    try {
      const res = await this.doFetch(this.o.url, { method: 'GET', signal: AbortSignal.timeout(this.o.timeoutMs) });
      if (res.ok) this.last = nowS;
      else this.log.warn({ status: res.status }, 'healthchecks ping rejected');
    } catch (e) {
      this.log.warn({ err: (e as Error).message }, 'healthchecks ping failed');
    } finally {
      this.inFlight = false;
    }
  }
}

/** Replay / tests: records pings instead of calling out. */
export class NullPinger implements Pinger {
  pings: number[] = [];
  async ping(nowS: number): Promise<void> {
    this.pings.push(nowS);
  }
  lastPingAt(): number | null {
    return this.pings.at(-1) ?? null;
  }
}
