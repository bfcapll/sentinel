import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadFixture } from '../src/rpc/fixture.js';
import { runReplay } from '../src/replay/harness.js';
import { DEMO, proxyUpgradeScenario } from '../src/replay/scenarios.js';
import { SyntheticChain } from '../src/replay/synthetic.js';
import { checkTimeline, type ReplayedAlert } from '../src/replay/timeline.js';
import { DEMO_CONFIG_DIR } from './helpers.js';

const out = (): string => mkdtempSync(path.join(tmpdir(), 'sentinel-replay-'));
const base = { configDir: DEMO_CONFIG_DIR, holding: DEMO.holding, from: DEMO.from, to: DEMO.to };

describe('replay harness (PLAN.md §8.1)', () => {
  it('replays the committed fixture with no network and passes the expected-alert timeline', async () => {
    const r = await runReplay({ ...base, fixture: 'proxy-upgrade', timeline: 'fixtures/proxy-upgrade.timeline.json', outDir: out() });
    expect(r.cycles).toBe(41);
    expect(r.fixtureMisses).toEqual([]);
    expect(r.timeline).toEqual({ ok: true, failures: [] });
    expect(r.alerts.map((a) => [a.block, a.tier, a.condition_key])).toEqual([
      [1020, 'P0', 'demo-proxy/proxy/token/implementation'],
      [1030, 'P0', 'demo-proxy/proxy/token/admin'],
    ]);
  });

  it('writes the fake Telegram sink as JSON lines and a JSON report', async () => {
    const dir = out();
    const r = await runReplay({ ...base, fixture: 'proxy-upgrade', outDir: dir });
    const lines = readFileSync(r.telegramSink, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as { type: string; bot: string; text: string });
    const sends = lines.filter((l) => l.type === 'send' && l.bot === 'p0');
    expect(sends).toHaveLength(2);
    expect(sends[0]!.text).toContain('implementation slot changed');
    expect(JSON.parse(readFileSync(r.reportFile, 'utf8')).alerts).toHaveLength(2);
  });

  it('the committed fixture is exactly what --record produces today (generator and harness in sync)', async () => {
    const rec = path.join(out(), 'rec.json');
    await runReplay({
      ...base, record: rec, outDir: out(),
      transports: [{ name: 'primary', role: 'primary', transport: new SyntheticChain(proxyUpgradeScenario()) }],
    });
    const committed = loadFixture('fixtures/proxy-upgrade.json');
    const fresh = loadFixture(rec);
    expect(Object.keys(fresh.entries)).toEqual(Object.keys(committed.entries));
    expect(fresh.entries).toEqual(committed.entries);
  });

  it('is deterministic: two replays give identical alerts', async () => {
    const a = await runReplay({ ...base, fixture: 'proxy-upgrade', outDir: out() });
    const b = await runReplay({ ...base, fixture: 'proxy-upgrade', outDir: out() });
    expect(a.alerts).toEqual(b.alerts);
  });

  it('a range where nothing happened fires nothing (noise test)', async () => {
    const r = await runReplay({ ...base, from: 1000, to: 1015, fixture: 'proxy-upgrade', outDir: out() });
    expect(r.alerts).toEqual([]);
  });

  it('fails loudly when the pipeline asks for data the fixture lacks', async () => {
    const r = await runReplay({ ...base, from: 1041, to: 1043, fixture: 'proxy-upgrade', outDir: out() }).catch((e: unknown) => e);
    expect(String(r instanceof Error ? r.message : JSON.stringify(r))).toMatch(/fixture miss/);
  });

  it('--position-usd makes exposure explicit; --as-wallet reads another holder', async () => {
    const fixed = await runReplay({ ...base, fixture: 'proxy-upgrade', positionUsd: 250_000, outDir: out() });
    const msg = readFileSync(fixed.telegramSink, 'utf8');
    expect(msg).toContain('$250,000.00');
    const asWallet = await runReplay({
      ...base,
      fixture: 'proxy-upgrade',
      asWallet: '0x9999999999999999999999999999999999999999',
      outDir: out(),
    }).catch((e: unknown) => e);
    // The fixture has no balance reads for that wallet: proves the override really changes what is read.
    expect(String(asWallet instanceof Error ? asWallet.message : 'no error')).toMatch(/fixture miss/);
  });

  it('rejects --record together with --fixture and unknown holdings', async () => {
    await expect(runReplay({ ...base, record: 'a', fixture: 'b', outDir: out() })).rejects.toThrow(/mutually exclusive/);
    await expect(runReplay({ ...base, holding: 'nope', fixture: 'proxy-upgrade', outDir: out() })).rejects.toThrow(/not found/);
  });

  it('timeline file may be passed as a path written elsewhere', async () => {
    const f = path.join(out(), 't.json');
    writeFileSync(f, JSON.stringify({ expected: [{ block: 1020, condition_key: 'demo-proxy/proxy/token/*', tier: 'P0' }] }));
    const r = await runReplay({ ...base, fixture: 'proxy-upgrade', timeline: f, outDir: out() });
    expect(r.timeline?.ok).toBe(true);
  });
});

describe('timeline assertions', () => {
  const alert = (over: Partial<ReplayedAlert>): ReplayedAlert => ({
    id: 1, block: 100, condition_key: 'h/proxy/x', tier: 'P0', title: 't', kind: 'open', fired_at: 1, resolved_at: null, ...over,
  });
  it('passes when every expected alert fires at or before its block', () => {
    expect(checkTimeline({ expected: [{ block: 100, condition_key: 'h/proxy/x', tier: 'P0' }] }, [alert({ block: 100 })]).ok).toBe(true);
    expect(checkTimeline({ expected: [{ block: 120, condition_key: 'h/proxy/x', tier: 'P0' }] }, [alert({ block: 100 })]).ok).toBe(true);
  });
  it('fails on late, missing, wrong-tier and must_not alerts', () => {
    const late = checkTimeline({ expected: [{ block: 90, condition_key: 'h/proxy/x', tier: 'P0' }] }, [alert({ block: 100 })]);
    expect(late.failures[0]).toMatch(/late/);
    expect(checkTimeline({ expected: [{ block: 100, condition_key: 'h/proxy/x', tier: 'P1' }] }, [alert({})]).failures[0]).toMatch(/missing/);
    expect(checkTimeline({ expected: [], must_not: [{ condition_key: 'h/*' }] }, [alert({})]).failures[0]).toMatch(/unexpected/);
    expect(checkTimeline({ expected: [], must_not: [{ condition_key: 'h/proxy/x', tier: 'P1' }] }, [alert({})]).ok).toBe(true);
  });
});
