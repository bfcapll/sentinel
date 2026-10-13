import type { Hex } from '../config/schema.js';

export type Tier = 'P0' | 'P1' | 'P2';

export const TIER_RANK: Record<Tier, number> = { P2: 0, P1: 1, P0: 2 };

export const maxTier = (a: Tier, b: Tier): Tier => (TIER_RANK[a] >= TIER_RANK[b] ? a : b);

/** Everything the renderer needs about *what* happened, supplied by the watcher. */
export interface AlertContext {
  /** Short headline, e.g. "EIP-1967 implementation slot changed". */
  title: string;
  /** One or two lines of detail (old -> new values, thresholds, ...). */
  detail?: string;
  /** Decoded action: function + args, or a plain description of the state change. */
  decoded?: string;
  txHash?: Hex;
  logIndex?: number;
  /** Block the observation was made at (state reads) or the log's block. */
  block?: number;
  /** Unix seconds when a queued action becomes executable. */
  eta?: number;
  /** Contract the condition is about. */
  address?: string;
}

/**
 * One evaluated condition for one cycle: the contract between watchers and the rules engine.
 * Watchers decide *whether* and at *which tier* a condition is breached (threshold logic lives
 * in rules/thresholds.ts); the engine decides when that becomes an alert.
 */
export interface Sample {
  key: string;
  holding: string;
  watcher: string;
  /** Threshold-table key, e.g. `proxy.impl_changed`. */
  rule: string;
  /** Tier the observation breaches at right now; null when not breaching. */
  tier: Tier | null;
  /**
   * Only meaningful when `tier === null`: true when the value is fully back inside the
   * resolve band; false when it sits in the hysteresis band (hold current state).
   */
  clear: boolean;
  clearReason?: string;
  /** Breach must persist at least this many blocks / cycles before opening. */
  persistence: { blocks: number; cycles: number };
  /** Clear must persist this many consecutive cycles before resolving. */
  resolveCycles: number;
  /** After resolving, re-opening is suppressed for this long. */
  cooldownS: number;
  /** When open, this condition means the exit path is closed (promotes P1 to P0). */
  exitBlocking?: boolean;
  context: AlertContext;
}

export type ConditionStatus = 'open' | 'closed';

export interface ConditionState {
  key: string;
  holding: string;
  watcher: string;
  rule: string;
  status: ConditionStatus;
  /** Highest tier reached while open (ratchets up, resets on resolve). */
  tier: Tier | null;
  openedAt: number | null;
  openedBlock: number | null;
  lastSeenAt: number;
  breachCycles: number;
  breachStartBlock: number | null;
  clearCycles: number;
  cooldownUntil: number;
  exitBlocking: boolean;
  context: AlertContext | null;
}

export type Transition =
  | { type: 'opened'; key: string; tier: Tier; sample: Sample }
  | { type: 'escalated'; key: string; from: Tier; tier: Tier; sample: Sample }
  | { type: 'resolved'; key: string; reason: string; previousTier: Tier; sample: Sample }
  | { type: 'still_open'; key: string };

export interface EvalPoint {
  block: number;
  /** Unix seconds. Wall clock live; block timestamp in replay. */
  ts: number;
}
