import type { ThresholdSpec } from './defaults.js';
import type { Tier } from './types.js';

export interface ThresholdOutcome {
  tier: Tier | null;
  /** True when the value is inside the resolve band (only meaningful when tier is null). */
  clear: boolean;
}

/**
 * Map a continuous value onto a tier, with a hysteresis resolve band.
 *
 *   direction 'above': breach when value >= boundary; clear when value < lowestBoundary * resolve_factor
 *   direction 'below': breach when value <  boundary; clear when value > highestBoundary * resolve_factor
 *
 * `resolve_factor` defaults to 1 (no hysteresis band: clear as soon as the value is back inside).
 */
export function evaluateThreshold(value: number, spec: ThresholdSpec): ThresholdOutcome {
  const dir = spec.direction ?? 'above';
  const bounds: Array<[Tier, number]> = [];
  if (spec.p0 !== undefined) bounds.push(['P0', spec.p0]);
  if (spec.p1 !== undefined) bounds.push(['P1', spec.p1]);
  if (spec.p2 !== undefined) bounds.push(['P2', spec.p2]);
  if (bounds.length === 0) return { tier: null, clear: true };

  // Most severe boundary first. For 'above' that is the largest number, for 'below' the smallest.
  bounds.sort((a, b) => (dir === 'above' ? b[1] - a[1] : a[1] - b[1]));
  for (const [tier, boundary] of bounds) {
    const breached = dir === 'above' ? value >= boundary : value < boundary;
    if (breached) return { tier, clear: false };
  }

  const factor = spec.resolve_factor ?? 1;
  if (dir === 'above') {
    const lowest = Math.min(...bounds.map((b) => b[1]));
    return { tier: null, clear: value < lowest * factor || factor >= 1 };
  }
  const highest = Math.max(...bounds.map((b) => b[1]));
  return { tier: null, clear: value > highest * factor || factor <= 1 };
}
