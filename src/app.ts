import { BlockTracker } from './chain/tracker.js';
import { loadConfig, type LoadedConfig } from './config/loader.js';
import { HealthchecksPinger } from './health/healthchecks.js';
import { createLogger, type Logger } from './log.js';
import { buildLiveRpc } from './rpc/factory.js';
import { Scheduler } from './scheduler.js';
import { Store } from './store/db.js';
import { createHttpGateway, TelegramService } from './telegram/index.js';
import { systemClock } from './time.js';

export interface RunningService {
  config: LoadedConfig;
  scheduler: Scheduler;
  stop(): Promise<void>;
}

const OPS_TICK_MS = 5000;

/**
 * Wire and start the live service: dual RPC, head tracker, scheduler, Telegram bots, heartbeat.
 * Everything long-lived is stopped by the returned `stop()`.
 */
export function startService(configDir: string, log?: Logger): RunningService {
  const config = loadConfig(configDir);
  const logger = log ?? createLogger(config.sentinel.logging);
  const clock = systemClock;
  const store = Store.open(config.sentinel.store.path);
  const rpc = buildLiveRpc(config.sentinel, clock, logger);
  const pinger = new HealthchecksPinger(
    {
      url: config.sentinel.healthchecks.ping_url,
      minIntervalS: config.sentinel.healthchecks.min_interval_s,
      timeoutMs: config.sentinel.healthchecks.timeout_ms,
    },
    logger,
  );

  let tracker: BlockTracker | null = null;
  const scheduler = new Scheduler({
    config,
    store,
    reader: rpc.client,
    log: logger,
    clock,
    pinger,
    rpcHealth: () => rpc.health.evaluate(clock.now()),
    headBlock: () => tracker?.latest() ?? null,
  });

  tracker = new BlockTracker(
    () => rpc.client.getBlockNumber(),
    rpc.ws,
    { pollIntervalMs: config.sentinel.rpc.poll_interval_ms, wsSilenceMs: config.sentinel.rpc.ws_silence_ms },
    (head, source) => {
      if (source === 'ws') rpc.health.observeHead(rpc.primaryName, head, clock.now());
      void scheduler.onHead(head);
    },
    logger,
  );

  const telegram = new TelegramService({
    store,
    gateway: createHttpGateway(config.sentinel.telegram),
    config: config.sentinel.telegram,
    explorer: config.sentinel.explorer,
    ownerUserId: config.wallets.telegram_user_id,
    status: scheduler,
    clock,
    log: logger,
  });

  const opsTimer = setInterval(() => {
    try {
      scheduler.opsTick();
    } catch (e) {
      logger.error({ err: (e as Error).message }, 'ops tick failed');
    }
  }, OPS_TICK_MS);
  const healthTimer = setInterval(() => {
    void rpc.client.pollHeads().catch((e: Error) => logger.warn({ err: e.message }, 'provider head poll failed'));
  }, config.sentinel.rpc.health_poll_ms);

  telegram.start();
  tracker.start();
  logger.info(
    { holdings: config.holdings.map((h) => h.id), chain: config.sentinel.chain, confirmations: config.sentinel.rpc.confirmations },
    'sentinel started',
  );

  return {
    config,
    scheduler,
    async stop(): Promise<void> {
      clearInterval(opsTimer);
      clearInterval(healthTimer);
      tracker?.stop();
      await telegram.stop();
      store.close();
      logger.info('sentinel stopped');
    },
  };
}
