import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { loadConfig, type LoadedConfig } from '../config/loader.js';
import type { Address } from '../config/schema.js';
import { NullPinger } from '../health/healthchecks.js';
import { silentLogger, type Logger } from '../log.js';
import { RpcClient, type ProviderEntry } from '../rpc/client.js';
import { emptyFixture, FixtureTransport, loadFixture, RecordingTransport, saveFixture, type Fixture } from '../rpc/fixture.js';
import { RpcHealth } from '../rpc/health.js';
import { HttpTransport } from '../rpc/http.js';
import type { RpcTransport } from '../rpc/types.js';
import { Scheduler, type CycleResult } from '../scheduler.js';
import { Store } from '../store/db.js';
import { makeFakeGateway } from '../telegram/fake.js';
import { TelegramService } from '../telegram/index.js';
import { FixedClock } from '../time.js';
import { checkTimeline, type ReplayedAlert, type Timeline, type TimelineResult } from './timeline.js';

export interface ReplayOptions {
  /** Config directory (default ./config). */
  configDir: string;
  holding: string;
  from: number;
  to: number;
  /** Replay every Nth block (default 1). */
  step?: number;
  /** Record every RPC response into this fixture (path, or name under ./fixtures). */
  record?: string;
  /** Replay from this fixture with no network (path, or name under ./fixtures). */
  fixture?: string;
  asWallet?: Address;
  positionUsd?: number;
  /** Expected-alert-timeline JSON file. */
  timeline?: string;
  /** Output directory for the JSON report and Telegram sink. */
  outDir: string;
  log?: Logger;
  /** Tests can inject an already-loaded config and transports. */
  loaded?: LoadedConfig;
  transports?: ProviderEntry[];
}

export interface ReplayReport {
  holding: string;
  from: number;
  to: number;
  cycles: number;
  alerts: ReplayedAlert[];
  resolved: Array<{ condition_key: string; block: number }>;
  fixtureMisses: string[];
  timeline?: TimelineResult;
  telegramSink: string;
  reportFile: string;
  fixtureFile?: string;
}

export function resolveFixturePath(arg: string, dir = 'fixtures'): string {
  const withExt = arg.endsWith('.json') ? arg : `${arg}.json`;
  return arg.includes('/') || arg.includes('\\') ? withExt : path.join(dir, withExt);
}

/**
 * Replay a holding over [from, to] through the SAME scheduler code path as live (PLAN.md §8.1):
 * the block loop only supplies pinned target blocks; reads, fold, rules, alert routing and
 * Telegram delivery are the production modules, with the Telegram bots swapped for a fake sink
 * that writes JSON lines and a clock driven by block timestamps.
 */
export async function runReplay(o: ReplayOptions): Promise<ReplayReport> {
  const log = o.log ?? silentLogger();
  const config = o.loaded ?? loadConfig(o.configDir);
  if (!config.holdings.some((h) => h.id === o.holding)) {
    throw new Error(`holding "${o.holding}" not found in ${o.configDir} (known: ${config.holdings.map((h) => h.id).join(', ')})`);
  }
  if (o.record && o.fixture) throw new Error('--record and --fixture are mutually exclusive');

  /* transports */
  let fixtureData: Fixture | undefined;
  let fixtureTransport: FixtureTransport | undefined;
  let providers: ProviderEntry[];
  const fixtureFile = o.record ? resolveFixturePath(o.record) : o.fixture ? resolveFixturePath(o.fixture) : undefined;
  if (o.transports) {
    providers = o.transports;
    if (o.record) {
      fixtureData = emptyFixture({ holding: o.holding, from: o.from, to: o.to, recordedAt: new Date().toISOString() });
      providers = providers.map((p) => ({ ...p, transport: new RecordingTransport(p.transport, fixtureData!) }));
    }
  } else if (o.fixture) {
    const f = loadFixture(fixtureFile!);
    fixtureTransport = new FixtureTransport(f);
    providers = [{ name: 'fixture', role: 'primary', transport: fixtureTransport }];
  } else {
    const r = config.sentinel.rpc;
    const mk = (url: string, label: string): RpcTransport =>
      new HttpTransport({ url, label, timeoutMs: r.request_timeout_ms, batch: { maxSize: 50, waitMs: 5 } });
    let primary = mk(r.primary.http, 'primary');
    let secondary = mk(r.secondary.http, 'secondary');
    if (o.record) {
      fixtureData = emptyFixture({ holding: o.holding, from: o.from, to: o.to, recordedAt: new Date().toISOString() });
      primary = new RecordingTransport(primary, fixtureData);
      secondary = new RecordingTransport(secondary, fixtureData);
    }
    providers = [
      { name: 'primary', role: 'primary', transport: primary },
      { name: 'secondary', role: 'secondary', transport: secondary },
    ];
  }

  const clock = new FixedClock(0);
  const health = new RpcHealth(config.sentinel.rpc.lag, providers.map((p) => ({ name: p.name, role: p.role })), 0);
  const reader = new RpcClient({ providers, health, clock, log, logChunk: config.sentinel.cycle.max_log_range });

  /* in-memory store, fake Telegram sink */
  const store = Store.open(':memory:');
  mkdirSync(o.outDir, { recursive: true });
  const sinkFile = path.join(o.outDir, `${o.holding}-${o.from}-${o.to}.telegram.jsonl`);
  writeFileSync(sinkFile, '');
  const gateway = makeFakeGateway(sinkFile, clock);

  const pinger = new NullPinger();
  const resolved: ReplayReport['resolved'] = [];
  let telegram: TelegramService;
  const scheduler = new Scheduler({
    config,
    store,
    reader,
    log,
    clock,
    useBlockTime: true,
    pinger,
    holdingFilter: [o.holding],
    ...(o.asWallet ? { position: { asWallet: o.asWallet } } : o.positionUsd !== undefined ? { position: { positionUsd: o.positionUsd } } : {}),
    onCommitted: async (r: CycleResult) => {
      clock.t = r.ts;
      for (const t of r.transitions) if (t.type === 'resolved') resolved.push({ condition_key: t.key, block: r.block });
      await telegram.tick();
      gateway.flush();
    },
  });
  telegram = new TelegramService({
    store,
    gateway,
    config: config.sentinel.telegram,
    explorer: config.sentinel.explorer,
    ownerUserId: config.wallets.telegram_user_id,
    status: scheduler,
    clock,
    log,
  });

  /* the block loop */
  const step = Math.max(1, o.step ?? 1);
  let cycles = 0;
  for (let b = o.from; b <= o.to; b += step) {
    // Keep the clock moving even if a cycle is skipped.
    const r = await scheduler.runAtBlock(b);
    if (r) cycles++;
  }
  gateway.flush();

  const alerts: ReplayedAlert[] = store.repos.alert.list().map((a) => ({
    id: a.id,
    block: a.block,
    condition_key: a.conditionKey,
    tier: a.tier,
    title: a.title,
    kind: a.kind,
    fired_at: a.firedAt,
    resolved_at: a.resolvedAt,
  }));

  let timeline: TimelineResult | undefined;
  if (o.timeline) {
    if (!existsSync(o.timeline)) throw new Error(`timeline file not found: ${o.timeline}`);
    timeline = checkTimeline(JSON.parse(readFileSync(o.timeline, 'utf8')) as Timeline, alerts);
  }

  if (o.record && fixtureData && fixtureFile) saveFixture(fixtureFile, fixtureData);

  const report: ReplayReport = {
    holding: o.holding,
    from: o.from,
    to: o.to,
    cycles,
    alerts,
    resolved,
    fixtureMisses: fixtureTransport?.misses ?? [],
    ...(timeline ? { timeline } : {}),
    telegramSink: sinkFile,
    reportFile: path.join(o.outDir, `${o.holding}-${o.from}-${o.to}.report.json`),
    ...(o.record && fixtureFile ? { fixtureFile } : {}),
  };
  writeFileSync(report.reportFile, JSON.stringify(report, null, 2) + '\n');
  store.close();
  return report;
}
