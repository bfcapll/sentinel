import type { Tier } from '../rules/types.js';

export interface TimelineExpectation {
  block: number;
  /** Exact key, or a prefix ending in `*`. */
  condition_key: string;
  tier: Tier;
}

export interface Timeline {
  /** Alerts that must fire, at or before `block`. */
  expected: TimelineExpectation[];
  /** Alerts that must NOT fire (noise tests). `tier` omitted = any tier. */
  must_not?: Array<{ condition_key: string; tier?: Tier }>;
}

export interface ReplayedAlert {
  id: number;
  block: number | null;
  condition_key: string;
  tier: Tier;
  title: string;
  kind: 'open' | 'escalation';
  fired_at: number;
  resolved_at: number | null;
}

export interface TimelineResult {
  ok: boolean;
  failures: string[];
}

const matches = (pattern: string, key: string): boolean =>
  pattern.endsWith('*') ? key.startsWith(pattern.slice(0, -1)) : key === pattern;

/**
 * PLAN.md §8.1: a test passes if every expected alert fires at or before the expected block
 * and no `must_not` alert fires.
 */
export function checkTimeline(t: Timeline, alerts: ReplayedAlert[]): TimelineResult {
  const failures: string[] = [];
  for (const e of t.expected) {
    const hits = alerts.filter((a) => matches(e.condition_key, a.condition_key) && a.tier === e.tier);
    if (hits.length === 0) {
      failures.push(`missing: ${e.tier} ${e.condition_key} (expected by block ${e.block})`);
      continue;
    }
    const earliest = Math.min(...hits.map((a) => a.block ?? Number.POSITIVE_INFINITY));
    if (earliest > e.block) failures.push(`late: ${e.tier} ${e.condition_key} fired at block ${earliest}, expected by ${e.block}`);
  }
  for (const m of t.must_not ?? []) {
    const hit = alerts.find((a) => matches(m.condition_key, a.condition_key) && (!m.tier || a.tier === m.tier));
    if (hit) failures.push(`unexpected: ${hit.tier} ${hit.condition_key} fired at block ${hit.block ?? '?'}`);
  }
  return { ok: failures.length === 0, failures };
}
