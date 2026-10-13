import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { dedupeSamples, evaluate, step } from '../src/rules/engine.js';
import type { ConditionState, Sample, Tier, Transition } from '../src/rules/types.js';

const mk = (over: Partial<Sample> = {}): Sample => ({
  key: 'h/w/k',
  holding: 'h',
  watcher: 'w',
  rule: 'r',
  tier: null,
  clear: true,
  persistence: { blocks: 1, cycles: 1 },
  resolveCycles: 1,
  cooldownS: 0,
  context: { title: 't' },
  ...over,
});
const breach = (tier: Tier, over: Partial<Sample> = {}): Sample => mk({ tier, clear: false, ...over });
const ok = (over: Partial<Sample> = {}): Sample => mk({ tier: null, clear: true, ...over });
const band = (over: Partial<Sample> = {}): Sample => mk({ tier: null, clear: false, ...over });

/** Feed samples at consecutive blocks (12s apart) and collect transition types. */
function run(samples: Sample[], startBlock = 100, startTs = 1000): { types: string[]; last: ConditionState } {
  let state: ConditionState | undefined;
  const types: string[] = [];
  samples.forEach((s, i) => {
    const r = step(state, s, { block: startBlock + i, ts: startTs + i * 12 });
    state = r.next;
    types.push(r.transition?.type ?? '-');
  });
  return { types, last: state! };
}

describe('condition state machine', () => {
  const cases: Array<{ name: string; samples: Sample[]; expect: string[] }> = [
    { name: 'opens immediately, then dedupes', samples: [breach('P0'), breach('P0'), breach('P0')], expect: ['opened', 'still_open', 'still_open'] },
    { name: 'resolves when clear', samples: [breach('P1'), ok()], expect: ['opened', 'resolved'] },
    { name: 'closed + clear is silent', samples: [ok(), ok()], expect: ['-', '-'] },
    { name: 'hysteresis band holds the condition open', samples: [breach('P1'), band(), band(), ok()], expect: ['opened', 'still_open', 'still_open', 'resolved'] },
    {
      name: 'resolve needs N consecutive clear cycles',
      samples: [breach('P1', { resolveCycles: 2 }), ok({ resolveCycles: 2 }), ok({ resolveCycles: 2 })],
      expect: ['opened', 'still_open', 'resolved'],
    },
    {
      name: 'a breach interrupts the clear streak',
      samples: [breach('P1', { resolveCycles: 2 }), ok({ resolveCycles: 2 }), breach('P1', { resolveCycles: 2 }), ok({ resolveCycles: 2 }), ok({ resolveCycles: 2 })],
      expect: ['opened', 'still_open', 'still_open', 'still_open', 'resolved'],
    },
    {
      name: 'persistence of 3 blocks',
      samples: Array.from({ length: 4 }, () => breach('P0', { persistence: { blocks: 3, cycles: 1 } })),
      expect: ['-', '-', 'opened', 'still_open'],
    },
    {
      name: 'persistence resets when the breach lapses',
      samples: [
        breach('P0', { persistence: { blocks: 3, cycles: 1 } }),
        breach('P0', { persistence: { blocks: 3, cycles: 1 } }),
        ok(),
        breach('P0', { persistence: { blocks: 3, cycles: 1 } }),
        breach('P0', { persistence: { blocks: 3, cycles: 1 } }),
        breach('P0', { persistence: { blocks: 3, cycles: 1 } }),
      ],
      expect: ['-', '-', '-', '-', '-', 'opened'],
    },
    {
      name: 'persistence by cycles',
      samples: [breach('P1', { persistence: { blocks: 1, cycles: 2 } }), breach('P1', { persistence: { blocks: 1, cycles: 2 } })],
      expect: ['-', 'opened'],
    },
    { name: 'escalation P1 -> P0', samples: [breach('P1'), breach('P0')], expect: ['opened', 'escalated'] },
    { name: 'no de-escalation noise', samples: [breach('P0'), breach('P1'), breach('P2')], expect: ['opened', 'still_open', 'still_open'] },
  ];
  for (const c of cases) {
    it(c.name, () => {
      expect(run(c.samples).types).toEqual(c.expect);
    });
  }

  it('cooldown blocks re-opening until it expires', () => {
    // ts advances 12s per sample; cooldown 30s => samples at +12 and +24 after resolve are ignored.
    const s = (t: Tier | null): Sample => (t ? breach(t, { cooldownS: 30 }) : ok({ cooldownS: 30 }));
    const { types } = run([s('P0'), s(null), s('P0'), s('P0'), s('P0'), s('P0')]);
    expect(types).toEqual(['opened', 'resolved', '-', '-', 'opened', 'still_open']);
  });

  it('tier ratchets while open and resets on resolve', () => {
    const r = run([breach('P2'), breach('P0'), breach('P1')]);
    expect(r.last.tier).toBe('P0');
    const r2 = run([breach('P0'), ok(), breach('P2')]);
    expect(r2.last.tier).toBe('P2');
  });

  it('records exit-blocking and clears it on resolve', () => {
    const r = run([breach('P0', { exitBlocking: true })]);
    expect(r.last.exitBlocking).toBe(true);
    expect(run([breach('P0', { exitBlocking: true }), ok()]).last.exitBlocking).toBe(false);
  });

  it('resolved transition carries the clear reason and previous tier', () => {
    const a = step(undefined, breach('P1'), { block: 1, ts: 1 });
    const b = step(a.next, ok({ clearReason: 'back to normal' }), { block: 2, ts: 2 });
    expect(b.transition).toMatchObject({ type: 'resolved', reason: 'back to normal', previousTier: 'P1' });
  });

  it('collapses duplicate samples for a key: highest tier wins', () => {
    const out = dedupeSamples([ok(), breach('P2'), breach('P0'), band()]);
    expect(out).toHaveLength(1);
    expect(out[0]?.tier).toBe('P0');
  });

  it('evaluate() omits still_open from transitions and returns all states', () => {
    const first = evaluate(new Map(), [breach('P0', { key: 'a' }), ok({ key: 'b' })], { block: 1, ts: 1 });
    expect(first.transitions.map((t) => t.type)).toEqual(['opened']);
    expect(first.states).toHaveLength(2);
    const prior = new Map(first.states.map((s) => [s.key, s]));
    const second = evaluate(prior, [breach('P0', { key: 'a' })], { block: 2, ts: 2 });
    expect(second.transitions).toEqual([]);
  });
});

describe('property: opened and resolved alternate per key', () => {
  const sampleArb = fc.record({
    key: fc.constantFrom('k1', 'k2', 'k3'),
    tier: fc.constantFrom<Tier | null>(null, 'P2', 'P1', 'P0'),
    clear: fc.boolean(),
    persistBlocks: fc.integer({ min: 1, max: 4 }),
    persistCycles: fc.integer({ min: 1, max: 3 }),
    resolveCycles: fc.integer({ min: 1, max: 3 }),
    cooldownS: fc.constantFrom(0, 20, 100),
    skip: fc.integer({ min: 1, max: 3 }),
  });

  it('never double-opens, never resolves a closed condition, tier only ratchets inside an episode', () => {
    fc.assert(
      fc.property(fc.array(sampleArb, { minLength: 1, maxLength: 120 }), (seq) => {
        let block = 1000;
        let ts = 10_000;
        const prior = new Map<string, ConditionState>();
        const history = new Map<string, Transition[]>();
        for (const a of seq) {
          block += a.skip;
          ts += a.skip * 12;
          const sample = mk({
            key: a.key,
            tier: a.tier,
            clear: a.tier ? false : a.clear,
            persistence: { blocks: a.persistBlocks, cycles: a.persistCycles },
            resolveCycles: a.resolveCycles,
            cooldownS: a.cooldownS,
          });
          const ev = evaluate(prior, [sample], { block, ts });
          for (const s of ev.states) prior.set(s.key, s);
          for (const t of ev.transitions) history.set(t.key, [...(history.get(t.key) ?? []), t]);
        }
        for (const ts of history.values()) {
          const letters = ts.map((t) => ({ opened: 'O', escalated: 'E', resolved: 'R', still_open: '' })[t.type]).join('');
          if (!/^(OE*R)*(OE*)?$/.test(letters)) return false;
          let rank = -1;
          for (const t of ts) {
            if (t.type === 'opened') rank = { P2: 0, P1: 1, P0: 2 }[t.tier];
            else if (t.type === 'escalated') {
              const r = { P2: 0, P1: 1, P0: 2 }[t.tier];
              if (r <= rank) return false;
              rank = r;
            } else rank = -1;
          }
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});
