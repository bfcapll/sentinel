import { describe, expect, it } from 'vitest';
import { HealthchecksPinger } from '../src/health/healthchecks.js';
import { WatcherErrors } from '../src/health/watcher-errors.js';
import { silentLogger } from '../src/log.js';
import { proxyWatcher, slotToAddress } from '../src/watchers/proxy.js';
import { DEMO } from '../src/replay/scenarios.js';

describe('HealthchecksPinger', () => {
  const mk = (impl: typeof fetch) => new HealthchecksPinger({ url: 'https://hc.invalid/x', minIntervalS: 60, timeoutMs: 1000, fetchImpl: impl }, silentLogger());

  it('throttles to one ping per interval and records the last success', async () => {
    let n = 0;
    const p = mk((async () => (n++, new Response('OK'))) as typeof fetch);
    await p.ping(1000);
    await p.ping(1030);
    await p.ping(1061);
    expect(n).toBe(2);
    expect(p.lastPingAt()).toBe(1061);
  });

  it('never throws: network errors and non-2xx leave lastPingAt untouched', async () => {
    const bad = mk((async () => { throw new Error('offline'); }) as typeof fetch);
    await expect(bad.ping(1)).resolves.toBeUndefined();
    expect(bad.lastPingAt()).toBeNull();
    const rejected = mk((async () => new Response('no', { status: 500 })) as typeof fetch);
    await rejected.ping(1);
    expect(rejected.lastPingAt()).toBeNull();
  });
});

describe('WatcherErrors', () => {
  const spec = { p1: 3, p0: 10 };
  it('P1 after 3 consecutive errors; P0-class escalates to P0 after 10 minutes; ok resets', () => {
    const w = new WatcherErrors();
    w.register('proxy');
    w.register('flows');
    for (let i = 0; i < 3; i++) w.recordError('proxy', 100 + i * 12, new Error('x'));
    for (let i = 0; i < 3; i++) w.recordError('flows', 100 + i * 12, new Error('x'));
    const at = (now: number) => Object.fromEntries(w.samples(now, spec).map((s) => [s.watcher, s.tier]));
    expect(at(140)).toEqual({ proxy: 'P1', flows: 'P1' });
    expect(at(100 + 600)).toEqual({ proxy: 'P0', flows: 'P1' });
    w.recordOk('proxy', 800);
    expect(at(800)).toMatchObject({ proxy: null });
    expect(w.samples(800, spec).find((s) => s.watcher === 'proxy')).toMatchObject({ clear: true });
  });
});

describe('proxy watcher helpers', () => {
  it('slotToAddress takes the low 20 bytes and checksums', () => {
    expect(slotToAddress(`0x${'0'.repeat(24)}${DEMO.implA.slice(2)}`)).toBe('0xaAaAaAaaAaAaAaaAaAAAAAAAAaaaAaAaAaaAaaAa');
    expect(slotToAddress(`0x${'0'.repeat(64)}`)).toBe('0x0000000000000000000000000000000000000000');
  });

  it('never embeds protocol addresses: the watcher plan comes entirely from config', () => {
    const src = proxyWatcher.plan.toString() + proxyWatcher.fold.toString();
    expect(src).not.toMatch(/0x[0-9a-fA-F]{40}/);
  });
});
