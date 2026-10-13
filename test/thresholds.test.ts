import { describe, expect, it } from 'vitest';
import { DEFAULT_THRESHOLDS, resolveThreshold } from '../src/rules/defaults.js';
import { evaluateThreshold } from '../src/rules/thresholds.js';

describe('evaluateThreshold', () => {
  const peg = DEFAULT_THRESHOLDS['peg.exit_cost'];
  it.each([
    [9, null, true],
    [15, null, false], // inside the 50% resolve band of the P2 boundary (20 * 0.5 = 10)
    [20, 'P2', false],
    [49, 'P2', false],
    [50, 'P1', false],
    [199, 'P1', false],
    [250, 'P0', false],
  ])('above-type exit cost %s bps -> %s (clear=%s)', (v, tier, clear) => {
    expect(evaluateThreshold(v, peg)).toEqual({ tier, clear });
  });

  const liq = DEFAULT_THRESHOLDS['liquidity.ratio'];
  it.each([
    [0.5, 'P0', false],
    [1.5, 'P1', false],
    [4, 'P2', false],
    [6, null, false], // 5 < 6 <= 5*1.5: hysteresis band
    [8, null, true],
  ])('below-type liquidity ratio %s -> %s (clear=%s)', (v, tier, clear) => {
    expect(evaluateThreshold(v, liq)).toEqual({ tier, clear });
  });

  it('no boundaries means never breached', () => {
    expect(evaluateThreshold(5, {})).toEqual({ tier: null, clear: true });
  });

  it('holding overrides beat global overrides beat defaults, field by field', () => {
    const spec = resolveThreshold('peg.exit_cost', { 'peg.exit_cost': { p1: 40 } }, { 'peg.exit_cost': { p0: 150 } });
    expect(spec).toMatchObject({ p0: 150, p1: 40, p2: 20, persistence_blocks: 15 });
  });
});
