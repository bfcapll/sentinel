import { describe, expect, it } from 'vitest';
import { routeTransitions, finalTier } from '../src/alerts/router.js';
import { computeExitPath, computePosition, planPosition, type ExitPath, type PositionSummary } from '../src/position/index.js';
import { evaluate } from '../src/rules/engine.js';
import type { Sample, Tier } from '../src/rules/types.js';
import { Store } from '../src/store/db.js';
import type { ReadMap } from '../src/watchers/types.js';
import { demoConfig } from './helpers.js';
import type { Holding } from '../src/config/schema.js';
import type { ReadResult } from '../src/rpc/types.js';

const readMap = (m: Record<string, unknown>): ReadMap => ({
  get: (id): ReadResult | undefined => (id in m ? { ok: true, value: m[id] } : undefined),
  require: <T>(id: string): T => m[id] as T,
});

const cfg = demoConfig();
const vault = (): Holding => ({
  ...cfg.holdings[0]!,
  kind: 'metamorpho',
  asset: { address: '0x1111111111111111111111111111111111111111', decimals: 18, symbol: 'steakUSDC', loan_token: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 } },
});

describe('position', () => {
  it('plain token: balance x const price, exit size 100%', () => {
    const h = cfg.holdings[0]!;
    const p = computePosition(h, cfg, readMap({ 'position/balance/main': 2_500_000n * 10n ** 6n }));
    expect(p.exposureUsd).toBe(2_500_000);
    expect(p.exitSizeUsd).toBe(2_500_000);
    expect(p.note).toContain('main: 2,500,000.00 DEMO');
  });

  it('vault: converts shares to assets with the ERC-4626 virtual-offset formula', () => {
    const h = vault();
    // 1 share-token (1e18) of a vault whose totalAssets/totalSupply imply 1.05 USDC per share (offset 1e12).
    const totalSupply = 100n * 10n ** 18n;
    const totalAssets = 105n * 10n ** 6n;
    const p = computePosition(h, cfg, readMap({ 'position/balance/main': 10n ** 18n, 'position/totalSupply': totalSupply, 'position/totalAssets': totalAssets }));
    // assets = shares * (totalAssets + 1) / (totalSupply + 10**12)
    const expected = Number((10n ** 18n * (totalAssets + 1n)) / (totalSupply + 10n ** 12n)) / 1e6;
    expect(p.amount).toBeCloseTo(expected, 9);
    expect(p.exposureUsd).toBeCloseTo(expected, 9);
  });

  it('chainlink price: reads latestRoundData with the registry decimals', () => {
    const c = { ...cfg, registries: { ...cfg.registries, chainlinkFeeds: { feeds: { 'USDC/USD': { address: '0x8fFfFfd4AfB6115b954Bd326cbe7B4BA576818f6' as const, decimals: 8, heartbeat_s: 86400 } } } } };
    const h = { ...cfg.holdings[0]!, exposure: { price_feed: 'chainlink:USDC/USD', exit_size: '50%' } };
    const reads = planPosition(h, c);
    expect(reads.map((r) => r.id)).toEqual(['position/balance/main', 'position/price']);
    const p = computePosition(h, c, readMap({ 'position/balance/main': 1000n * 10n ** 6n, 'position/price': [1n, 99_900_000n, 0n, 0n, 1n] }));
    expect(p.exposureUsd).toBeCloseTo(999);
    expect(p.exitSizeUsd).toBeCloseTo(499.5);
  });

  it('absolute exit size and --position-usd override (no balance reads planned)', () => {
    const h = { ...cfg.holdings[0]!, exposure: { price_feed: 'const:1.0', exit_size: 100_000 } };
    expect(computePosition(h, cfg, readMap({ 'position/balance/main': 5_000_000n * 10n ** 6n })).exitSizeUsd).toBe(100_000);
    expect(planPosition(h, cfg, { positionUsd: 7 })).toEqual([]);
    expect(computePosition(h, cfg, readMap({}), { positionUsd: 7 }).exposureUsd).toBe(7);
  });

  it('--as-wallet reads that address instead of the configured wallets', () => {
    const reads = planPosition(cfg.holdings[0]!, cfg, { asWallet: '0x9999999999999999999999999999999999999999' });
    expect(reads[0]).toMatchObject({ id: 'position/balance/as-wallet', args: ['0x9999999999999999999999999999999999999999'] });
  });

  it('unreadable inputs give null exposure plus a warning, never a made-up number', () => {
    const p = computePosition(cfg.holdings[0]!, cfg, { get: () => ({ ok: false, error: 'reverted' }), require: () => { throw new Error('x'); } });
    expect(p.exposureUsd).toBeNull();
    expect(p.warnings.join()).toMatch(/unreadable/);
    const nav = computePosition({ ...cfg.holdings[0]!, exposure: { price_feed: 'nav-oracle', exit_size: '100%' } }, cfg, readMap({ 'position/balance/main': 1n }));
    expect(nav.exposureUsd).toBeNull();
  });

  it('exit path is CLOSED only while an exit-blocking condition is open for that holding', () => {
    const open = (holding: string, exitBlocking: boolean) => ({
      key: `${holding}/k`, holding, watcher: 'w', rule: 'r', status: 'open' as const, tier: 'P0' as Tier, openedAt: 1, openedBlock: 1, lastSeenAt: 1,
      breachCycles: 0, breachStartBlock: null, clearCycles: 0, cooldownUntil: 0, exitBlocking, context: { title: 'Protocol paused' },
    });
    expect(computeExitPath('a', [open('a', false), open('b', true)]).open).toBe(true);
    expect(computeExitPath('a', [open('a', true)])).toEqual({ open: false, reason: 'Protocol paused' });
  });
});

describe('alert routing', () => {
  const sample = (over: Partial<Sample>): Sample => ({
    key: 'demo-proxy/x/y', holding: 'demo-proxy', watcher: 'x', rule: 'r', tier: 'P1', clear: false,
    persistence: { blocks: 1, cycles: 1 }, resolveCycles: 1, cooldownS: 0, context: { title: 'Something queued' }, ...over,
  });
  const positions = new Map<string, PositionSummary>([['demo-proxy', { holdingId: 'demo-proxy', exposureUsd: 123_456.78, note: 'main: 1 DEMO', wallets: [], amount: 1, price: 1, exitSizeUsd: 1, warnings: [] }]]);

  it('promotes a P1 to P0 when the exit path is CLOSED at fire time (PLAN.md §6.1)', () => {
    expect(finalTier('P1', false, { open: false, reason: 'paused' })).toEqual({ tier: 'P0', promoted: true });
    expect(finalTier('P1', false, { open: true, reason: '' }).tier).toBe('P1');
    expect(finalTier('P1', true, { open: false, reason: '' }).tier).toBe('P1'); // OPS keeps its tier
    expect(finalTier('P2', false, { open: false, reason: '' }).tier).toBe('P2');
  });

  const route = (store: Store, s: Sample, exit: ExitPath, ts: number) => {
    const ev = evaluate(store.repos.condition.all(), [s], { block: ts, ts });
    for (const st of ev.states) store.repos.condition.upsert(st);
    return routeTransitions({ store, config: cfg, transitions: ev.transitions, positions, exitPaths: new Map([['demo-proxy', exit]]), at: { block: ts, ts } });
  };

  it('creates rendered alert rows with exposure and exit path; P2 goes to the digest queue', () => {
    const store = Store.open(':memory:');
    const r = route(store, sample({ tier: 'P1' }), { open: false, reason: 'USDC paused' }, 1);
    const a = store.repos.alert.get(r.created[0]!.id)!;
    expect(a).toMatchObject({ tier: 'P0', exposureUsd: 123_456.78, exitPathOpen: false, sendState: 'pending' });
    expect(a.message).toContain('Promoted from P1');
    expect(a.message).toContain('Exit path: CLOSED');
    const p2 = route(store, sample({ key: 'demo-proxy/p2', tier: 'P2' }), { open: true, reason: 'ok' }, 2);
    expect(store.repos.alert.get(p2.created[0]!.id)?.sendState).toBe('digest');
  });

  it('escalation creates a new alert and supersedes the old one; resolve closes both', () => {
    const store = Store.open(':memory:');
    const open = { open: true, reason: 'ok' };
    const first = route(store, sample({ tier: 'P1' }), open, 1).created[0]!;
    const second = route(store, sample({ tier: 'P0' }), open, 2).created[0]!;
    expect(store.repos.alert.get(first.id)?.supersededBy).toBe(second.id);
    expect(store.repos.alert.get(second.id)?.kind).toBe('escalation');
    route(store, sample({ tier: null, clear: true, clearReason: 'fixed' }), open, 3);
    expect(store.repos.alert.list().every((a) => a.resolvedAt === 3 && a.resolveReason === 'fixed')).toBe(true);
  });
});
