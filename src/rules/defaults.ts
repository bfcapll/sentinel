/**
 * Default threshold table (PLAN.md §6.2). Every key is overridable per holding
 * under `thresholds:` in the holding YAML, or globally in sentinel.yaml.
 *
 * Numeric fields are tier boundaries; `direction` says whether a breach means the
 * observed value is above (default) or below the boundary. Binary conditions
 * (proxy changed, safe module enabled, ...) carry no numbers: the watcher decides
 * the tier from the decoded change, per the table in the plan.
 */
export interface ThresholdSpec {
  p0?: number;
  p1?: number;
  p2?: number;
  direction?: 'above' | 'below';
  unit?: string;
  /** Breach must be observed over at least this many blocks before opening. */
  persistence_blocks?: number;
  /** Breach must be observed in at least this many consecutive cycles before opening. */
  persistence_cycles?: number;
  /** Resolve band: above-type clears below boundary*factor, below-type above boundary*factor. */
  resolve_factor?: number;
  /** Clear must be observed in this many consecutive cycles before resolving. */
  resolve_cycles?: number;
  /** After resolving, the same key cannot re-open for this many seconds. */
  cooldown_s?: number;
}

const bin: ThresholdSpec = { cooldown_s: 0 };

export const DEFAULT_THRESHOLDS = {
  'proxy.impl_changed': bin,
  'proxy.diamond_cut': bin,
  'owner.changed': bin,
  'owner.pending': bin,
  'safe.owner_set': bin,
  'safe.module_guard': bin,
  'role.grant': bin,
  'role.revoke': bin,
  'mint.unexpected': { p1: 1, unit: '% of supply / 24h', cooldown_s: 0 },
  'timelock.queued': bin,
  'timelock.delay': bin,
  'timelock.cancelled': bin,
  'morpho.pending_cap': { p0: 20, unit: '% of vault in the market', cooldown_s: 0 },
  'morpho.pending_removal': { p0: 20, unit: '% of vault in the market', cooldown_s: 0 },
  'morpho.pending_timelock': { p0: 86_400, direction: 'below', unit: 'seconds (new timelock)', cooldown_s: 0 },
  'morpho.guardian': bin,
  'morpho.fee': { p0: 30, unit: '% fee', cooldown_s: 0 },
  'morpho.bad_debt': { p0: 1, unit: '% of vault assets', cooldown_s: 0 },
  'morpho.v2_gate': bin,
  'safe.proposed_tx': bin,
  'pause.protocol': bin,
  'aave.frozen': bin,
  'aave.caps': { p1: 1.1, unit: 'supply cap / current supply', direction: 'below', cooldown_s: 0 },
  'blacklist.hit': bin,
  'oracle.stale': {
    p1: 1.25,
    p0: 2,
    unit: 'x heartbeat',
    persistence_cycles: 2,
    cooldown_s: 0,
  },
  'oracle.divergence': {
    p2: 50,
    p1: 100,
    p0: 300,
    unit: 'bps',
    persistence_blocks: 15,
    resolve_factor: 0.5,
    cooldown_s: 600,
  },
  'oracle.hardcoded': bin,
  'oracle.source_changed': bin,
  'peg.exit_cost': {
    p2: 20,
    p1: 50,
    p0: 200,
    unit: 'bps',
    persistence_blocks: 15,
    resolve_factor: 0.5,
    cooldown_s: 600,
  },
  'peg.imbalance': {
    p2: 45,
    p1: 55,
    p0: 70,
    unit: '% max coin share',
    persistence_blocks: 30,
    resolve_factor: 0.9,
    cooldown_s: 600,
  },
  'liquidity.ratio': {
    p2: 5,
    p1: 2,
    p0: 1,
    direction: 'below',
    unit: 'withdrawable / position',
    persistence_blocks: 10,
    resolve_factor: 1.5,
    cooldown_s: 600,
  },
  'liquidity.utilization': {
    p2: 85,
    p1: 92,
    p0: 98,
    unit: '% utilization',
    persistence_blocks: 10,
    resolve_factor: 0.95,
    cooldown_s: 600,
  },
  'curator.new_market': bin,
  'curator.concentration': { p2: 10, p1: 20, p0: 50, unit: 'pts (p0: % of vault)', cooldown_s: 0 },
  'curator.public_alloc': { p1: 10, unit: '% of vault moved', cooldown_s: 0 },
  'flows.tvl': { unit: '% change over window (windows in holding.flows)', cooldown_s: 0 },
  'flows.top_holder': { p1: 5, p0: 15, unit: '% of TVL in one tx', cooldown_s: 0 },
  'rwa.nav_stale': { p1: 1.5, p0: 3, unit: 'x heartbeat', cooldown_s: 0 },
  'rwa.nav_jump': { p2: 0, p1: 25, p0: 100, unit: 'bps per update', cooldown_s: 0 },
  'rwa.allowlist': bin,
  'rwa.redemption': bin,
  'rwa.supply_vs_aum': { p2: 0.5, p1: 2, unit: '% divergence', cooldown_s: 0 },
  'rwa.admin_action': bin,
  'rwa.shared_redeemer': {
    p2: 5,
    p1: 2,
    p0: 1,
    direction: 'below',
    unit: 'x position',
    persistence_blocks: 10,
    cooldown_s: 600,
  },
  'ops.rpc_lag': bin,
  'ops.chain_blind': bin,
  'ops.watcher_error': { p1: 3, p0: 10, unit: 'p1: consecutive cycles; p0: minutes for P0-class watchers', cooldown_s: 0 },
  'ops.heartbeat': bin,
} as const satisfies Record<string, ThresholdSpec>;

export type ThresholdKey = keyof typeof DEFAULT_THRESHOLDS;
export const THRESHOLD_KEYS = Object.keys(DEFAULT_THRESHOLDS) as ThresholdKey[];

export function isThresholdKey(k: string): k is ThresholdKey {
  return Object.prototype.hasOwnProperty.call(DEFAULT_THRESHOLDS, k);
}

/** Watchers whose silence means "blind to the thing that matters most" (PLAN.md §6.1). */
export const P0_CLASS_WATCHERS: readonly string[] = ['proxy', 'safe', 'pause'];

/** Merge per-key overrides (global, then holding) over the defaults. */
export function resolveThreshold(
  key: ThresholdKey,
  ...overrides: Array<Partial<Record<string, ThresholdSpec>> | undefined>
): ThresholdSpec {
  let spec: ThresholdSpec = { ...DEFAULT_THRESHOLDS[key] };
  for (const o of overrides) {
    const v = o?.[key];
    if (v) spec = { ...spec, ...v };
  }
  return spec;
}
