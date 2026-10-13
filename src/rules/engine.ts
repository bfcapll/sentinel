import {
  TIER_RANK,
  type ConditionState,
  type EvalPoint,
  type Sample,
  type Tier,
  type Transition,
} from './types.js';

export function newCondition(sample: Sample, at: EvalPoint): ConditionState {
  return {
    key: sample.key,
    holding: sample.holding,
    watcher: sample.watcher,
    rule: sample.rule,
    status: 'closed',
    tier: null,
    openedAt: null,
    openedBlock: null,
    lastSeenAt: at.ts,
    breachCycles: 0,
    breachStartBlock: null,
    clearCycles: 0,
    cooldownUntil: 0,
    exitBlocking: false,
    context: null,
  };
}

export interface StepResult {
  next: ConditionState;
  transition?: Transition;
}

/**
 * The condition state machine (PLAN.md §4 "dedupe", §6 hysteresis/persistence/cooldown).
 * Pure: (prior state, sample, evaluation point) -> (next state, transition).
 *
 *   closed --breach x persistence--> open --clear x resolveCycles--> closed (+cooldown)
 *   open --breach at higher tier--> open (escalated)
 *
 * Invariants the property test checks: `opened` and `resolved` alternate per key; an open
 * condition never re-opens; a resolved condition cannot re-open inside its cooldown.
 */
export function step(prev: ConditionState | undefined, sample: Sample, at: EvalPoint): StepResult {
  const s: ConditionState = prev ? { ...prev } : newCondition(sample, at);
  s.holding = sample.holding;
  s.watcher = sample.watcher;
  s.rule = sample.rule;

  if (s.status === 'closed') return stepClosed(s, sample, at);
  return stepOpen(s, sample, at);
}

function stepClosed(s: ConditionState, sample: Sample, at: EvalPoint): StepResult {
  if (sample.tier === null) {
    s.breachCycles = 0;
    s.breachStartBlock = null;
    s.lastSeenAt = at.ts;
    return { next: s };
  }
  if (at.ts < s.cooldownUntil) {
    // Cooling down after a resolve: breaches are ignored and do not accumulate.
    s.breachCycles = 0;
    s.breachStartBlock = null;
    return { next: s };
  }
  if (s.breachStartBlock === null) s.breachStartBlock = at.block;
  s.breachCycles += 1;
  const spanBlocks = at.block - s.breachStartBlock + 1;
  const needBlocks = Math.max(1, sample.persistence.blocks);
  const needCycles = Math.max(1, sample.persistence.cycles);
  s.lastSeenAt = at.ts;
  if (spanBlocks < needBlocks || s.breachCycles < needCycles) return { next: s };

  s.status = 'open';
  s.tier = sample.tier;
  s.openedAt = at.ts;
  s.openedBlock = at.block;
  s.clearCycles = 0;
  s.exitBlocking = !!sample.exitBlocking;
  s.context = sample.context;
  return { next: s, transition: { type: 'opened', key: s.key, tier: sample.tier, sample } };
}

function stepOpen(s: ConditionState, sample: Sample, at: EvalPoint): StepResult {
  s.lastSeenAt = at.ts;
  if (sample.tier !== null) {
    s.clearCycles = 0;
    s.exitBlocking = s.exitBlocking || !!sample.exitBlocking;
    const cur: Tier = s.tier ?? sample.tier;
    if (TIER_RANK[sample.tier] > TIER_RANK[cur]) {
      s.tier = sample.tier;
      s.context = sample.context;
      return { next: s, transition: { type: 'escalated', key: s.key, from: cur, tier: sample.tier, sample } };
    }
    return { next: s, transition: { type: 'still_open', key: s.key } };
  }
  if (!sample.clear) {
    // Inside the hysteresis band: hold.
    s.clearCycles = 0;
    return { next: s, transition: { type: 'still_open', key: s.key } };
  }
  s.clearCycles += 1;
  if (s.clearCycles < Math.max(1, sample.resolveCycles)) {
    return { next: s, transition: { type: 'still_open', key: s.key } };
  }
  const previousTier = s.tier ?? 'P2';
  s.status = 'closed';
  s.tier = null;
  s.openedAt = null;
  s.openedBlock = null;
  s.breachCycles = 0;
  s.breachStartBlock = null;
  s.clearCycles = 0;
  s.exitBlocking = false;
  s.cooldownUntil = at.ts + Math.max(0, sample.cooldownS);
  return {
    next: s,
    transition: {
      type: 'resolved',
      key: s.key,
      reason: sample.clearReason ?? 'condition cleared',
      previousTier,
      sample,
    },
  };
}

export interface CycleEvaluation {
  states: ConditionState[];
  transitions: Transition[];
}

/** Collapse duplicate samples for one key within a cycle: highest tier wins, else breach beats clear. */
export function dedupeSamples(samples: Sample[]): Sample[] {
  const byKey = new Map<string, Sample>();
  for (const s of samples) {
    const cur = byKey.get(s.key);
    if (!cur) {
      byKey.set(s.key, s);
      continue;
    }
    const rank = (x: Sample): number => (x.tier ? TIER_RANK[x.tier] + 2 : x.clear ? 0 : 1);
    if (rank(s) > rank(cur)) byKey.set(s.key, s);
  }
  return [...byKey.values()];
}

/** Evaluate a whole cycle's samples against the prior condition states. */
export function evaluate(prior: Map<string, ConditionState>, samples: Sample[], at: EvalPoint): CycleEvaluation {
  const states: ConditionState[] = [];
  const transitions: Transition[] = [];
  for (const sample of dedupeSamples(samples)) {
    const { next, transition } = step(prior.get(sample.key), sample, at);
    states.push(next);
    if (transition && transition.type !== 'still_open') transitions.push(transition);
  }
  return { states, transitions };
}
