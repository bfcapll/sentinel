import type { ProviderRole } from './types.js';

export interface LagRules {
  max_block_diff: number;
  diff_secs: number;
  stall_secs: number;
  blind_secs: number;
}

interface ProviderState {
  name: string;
  role: ProviderRole;
  head: number | null;
  lastAdvanceAt: number;
  firstSeenAt: number;
  errors: number[];
}

export interface ProviderHealth {
  name: string;
  role: ProviderRole;
  head: number | null;
  /** Blocks behind the highest head among primary/secondary/canary. */
  lagBlocks: number | null;
  /** Seconds since the head last advanced. */
  stalledForS: number;
  errors1m: number;
}

export interface HealthEvaluation {
  /** Provider name reads should go to first. */
  active: string;
  /** PLAN.md §3.2: divergence > N blocks for > 60s, or either provider silent > 90s. */
  rpcLag: boolean;
  /** Both primary and secondary silent for > 5 min: every watcher is blind. */
  chainBlind: boolean;
  reasons: string[];
  /** Did the public canary advance recently (tells "provider problem" from "chain slow")? */
  canaryAdvancing: boolean | null;
  providers: ProviderHealth[];
}

const ERROR_WINDOW_S = 60;
const ERROR_BURST = 5;
const FAILBACK_QUIET_S = 60;

/**
 * Pure bookkeeping for the dual-RPC health rules (PLAN.md §3.2). No I/O: the client feeds it
 * head observations and errors, `evaluate(now)` returns what to alert and which provider to use.
 */
export class RpcHealth {
  private readonly providers = new Map<string, ProviderState>();
  private divergedSince: number | null = null;
  private active: string;
  private primaryQuietSince: number | null = null;

  constructor(
    private readonly rules: LagRules,
    providers: Array<{ name: string; role: ProviderRole }>,
    now: number,
  ) {
    for (const p of providers) {
      if (this.providers.has(p.name)) throw new Error(`duplicate RPC provider name "${p.name}"`);
      this.providers.set(p.name, { ...p, head: null, lastAdvanceAt: now, firstSeenAt: now, errors: [] });
    }
    const primary = providers.find((p) => p.role === 'primary');
    if (!primary) throw new Error('RpcHealth needs a primary provider');
    this.active = primary.name;
  }

  observeHead(name: string, head: number, now: number): void {
    const p = this.providers.get(name);
    if (!p) return;
    if (p.head === null || head > p.head) p.lastAdvanceAt = now;
    if (p.head === null || head > p.head) p.head = head;
  }

  recordError(name: string, now: number): void {
    const p = this.providers.get(name);
    if (!p) return;
    p.errors.push(now);
    this.trim(p, now);
  }

  private trim(p: ProviderState, now: number): void {
    while (p.errors.length > 0 && (p.errors[0] as number) < now - ERROR_WINDOW_S) p.errors.shift();
  }

  private byRole(role: ProviderRole): ProviderState | undefined {
    return [...this.providers.values()].find((p) => p.role === role);
  }

  evaluate(now: number): HealthEvaluation {
    const primary = this.byRole('primary')!;
    const secondary = this.byRole('secondary');
    const canary = this.byRole('canary');
    for (const p of this.providers.values()) this.trim(p, now);

    const stalledFor = (p: ProviderState): number => now - p.lastAdvanceAt;
    const isStalled = (p: ProviderState | undefined): boolean => !!p && stalledFor(p) > this.rules.stall_secs;
    const reasons: string[] = [];

    // Divergence between primary and secondary, sustained.
    let diverged = false;
    if (secondary && primary.head !== null && secondary.head !== null) {
      const diff = Math.abs(primary.head - secondary.head);
      if (diff > this.rules.max_block_diff) {
        this.divergedSince ??= now;
        if (now - this.divergedSince > this.rules.diff_secs) {
          diverged = true;
          reasons.push(`primary and secondary heads differ by ${diff} blocks for ${now - this.divergedSince}s`);
        }
      } else {
        this.divergedSince = null;
      }
    }
    if (isStalled(primary)) reasons.push(`${primary.name} has not advanced for ${stalledFor(primary)}s`);
    if (isStalled(secondary)) reasons.push(`${secondary!.name} has not advanced for ${stalledFor(secondary!)}s`);

    const rpcLag = diverged || isStalled(primary) || isStalled(secondary);
    const chainBlind =
      !!secondary &&
      stalledFor(primary) > this.rules.blind_secs &&
      stalledFor(secondary) > this.rules.blind_secs;

    this.active = this.chooseActive(primary, secondary, now, rpcLag, isStalled);

    const heads = [...this.providers.values()].map((p) => p.head).filter((h): h is number => h !== null);
    const best = heads.length ? Math.max(...heads) : null;
    return {
      active: this.active,
      rpcLag,
      chainBlind,
      reasons,
      canaryAdvancing: canary ? stalledFor(canary) <= this.rules.stall_secs : null,
      providers: [...this.providers.values()].map((p) => ({
        name: p.name,
        role: p.role,
        head: p.head,
        lagBlocks: p.head !== null && best !== null ? best - p.head : null,
        stalledForS: stalledFor(p),
        errors1m: p.errors.length,
      })),
    };
  }

  /**
   * Switch away from the primary when it is stalled, behind the secondary by more than the
   * allowed diff, or erroring in bursts. Switch back only after it has been clean for a minute,
   * so the active provider does not flap.
   */
  private chooseActive(
    primary: ProviderState,
    secondary: ProviderState | undefined,
    now: number,
    rpcLag: boolean,
    isStalled: (p: ProviderState | undefined) => boolean,
  ): string {
    if (!secondary) return primary.name;
    const behind =
      primary.head !== null && secondary.head !== null && secondary.head - primary.head > this.rules.max_block_diff;
    const primaryBad = isStalled(primary) || behind || primary.errors.length >= ERROR_BURST;
    const secondaryBad = isStalled(secondary) || secondary.errors.length >= ERROR_BURST;

    if (primaryBad && !secondaryBad) {
      this.primaryQuietSince = null;
      return secondary.name;
    }
    if (this.active === secondary.name && !secondaryBad) {
      // Currently failed over: wait for primary to be clean for a while.
      if (primaryBad || rpcLag) {
        this.primaryQuietSince = null;
        return secondary.name;
      }
      this.primaryQuietSince ??= now;
      return now - this.primaryQuietSince >= FAILBACK_QUIET_S ? primary.name : secondary.name;
    }
    this.primaryQuietSince = null;
    return primary.name;
  }

  heads(): Array<{ name: string; head: number | null }> {
    return [...this.providers.values()].map((p) => ({ name: p.name, head: p.head }));
  }
}
