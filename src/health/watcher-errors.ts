import { P0_CLASS_WATCHERS, type ThresholdSpec } from '../rules/defaults.js';
import type { Sample } from '../rules/types.js';

interface WatcherErrorState {
  consecutive: number;
  firstErrorAt: number | null;
  lastError: string | null;
  lastOkAt: number | null;
}

/**
 * Watcher error accounting (PLAN.md §6.1): a watcher failing 3 consecutive cycles raises
 * OPS P1; a P0-class watcher (proxy, safe, pause) failing for 10 minutes raises OPS P0,
 * because the service is then blind to the thing that matters most.
 */
export class WatcherErrors {
  private readonly state = new Map<string, WatcherErrorState>();

  private get(name: string): WatcherErrorState {
    let s = this.state.get(name);
    if (!s) {
      s = { consecutive: 0, firstErrorAt: null, lastError: null, lastOkAt: null };
      this.state.set(name, s);
    }
    return s;
  }

  /** Make sure a watcher shows up in status even before its first cycle. */
  register(name: string): void {
    this.get(name);
  }

  recordOk(name: string, now: number): void {
    const s = this.get(name);
    s.consecutive = 0;
    s.firstErrorAt = null;
    s.lastOkAt = now;
  }

  recordError(name: string, now: number, err: unknown): void {
    const s = this.get(name);
    s.consecutive += 1;
    s.firstErrorAt ??= now;
    s.lastError = err instanceof Error ? err.message : String(err);
  }

  snapshot(): Array<{ name: string; consecutiveErrors: number; lastError: string | null; lastOkAt: number | null }> {
    return [...this.state.entries()].map(([name, s]) => ({
      name,
      consecutiveErrors: s.consecutive,
      lastError: s.lastError,
      lastOkAt: s.lastOkAt,
    }));
  }

  /** `ops.watcher_error` conditions for every known watcher at `now`. */
  samples(now: number, spec: ThresholdSpec): Sample[] {
    const p1Cycles = spec.p1 ?? 3;
    const p0Minutes = spec.p0 ?? 10;
    return [...this.state.entries()].map(([name, s]) => {
      const erroredFor = s.firstErrorAt === null ? 0 : now - s.firstErrorAt;
      const p0Class = P0_CLASS_WATCHERS.includes(name);
      const tier = p0Class && s.consecutive > 0 && erroredFor >= p0Minutes * 60 ? 'P0' : s.consecutive >= p1Cycles ? 'P1' : null;
      return {
        key: `ops/watcher/${name}/error`,
        holding: 'ops',
        watcher: name,
        rule: 'ops.watcher_error',
        tier,
        clear: s.consecutive === 0,
        clearReason: `watcher ${name} succeeded again`,
        persistence: { blocks: 1, cycles: 1 },
        resolveCycles: 1,
        cooldownS: spec.cooldown_s ?? 0,
        context: {
          title: `Watcher "${name}" is failing`,
          detail: `${s.consecutive} consecutive failed cycle(s), first failure ${Math.round(erroredFor)}s ago.\nLast error: ${s.lastError ?? 'n/a'}${
            p0Class ? '\nThis is a P0-class watcher: the service is blind to it.' : ''
          }`,
          decoded: 'n/a (infrastructure)',
        },
      } satisfies Sample;
    });
  }
}
