import type { SentinelConfig } from '../config/schema.js';
import type { StatusProvider } from '../health/status.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/db.js';
import type { Clock } from '../time.js';
import type { Gateway } from './api.js';
import { UpdateHandler } from './commands.js';
import { AlertDelivery } from './delivery.js';
import { DigestJob } from './digest.js';
import { UpdatePoller } from './poller.js';

export { createHttpGateway, HttpBotClient, TelegramError } from './api.js';
export type { BotClient, BotName, Gateway, InlineButton, TgUpdate } from './api.js';
export { FakeBotClient, makeFakeGateway } from './fake.js';
export { AlertDelivery } from './delivery.js';
export { DigestJob } from './digest.js';
export { UpdateHandler } from './commands.js';
export { UpdatePoller } from './poller.js';

export interface TelegramServiceOptions {
  store: Store;
  gateway: Gateway;
  config: SentinelConfig['telegram'];
  explorer: SentinelConfig['explorer'];
  /** wallets.yaml telegram_user_id: the only user allowed to ACK / run commands. */
  ownerUserId: number;
  status: StatusProvider;
  clock: Clock;
  log: Logger;
  /** Delivery / digest cadence while running. Default 5000. */
  tickIntervalMs?: number;
  pollTimeoutS?: number;
}

export class TelegramService {
  readonly delivery: AlertDelivery;
  readonly digest: DigestJob;
  readonly handler: UpdateHandler;
  readonly poller: UpdatePoller;
  private timer: NodeJS.Timeout | null = null;
  private ticking: Promise<void> | null = null;
  private readonly intervalMs: number;

  constructor(o: TelegramServiceOptions) {
    this.intervalMs = o.tickIntervalMs ?? 5000;
    this.delivery = new AlertDelivery({ store: o.store, gateway: o.gateway, config: o.config, explorer: o.explorer, clock: o.clock, log: o.log });
    this.digest = new DigestJob({ store: o.store, gateway: o.gateway, config: o.config, status: o.status, clock: o.clock, log: o.log });
    this.handler = new UpdateHandler({
      store: o.store,
      gateway: o.gateway,
      config: o.config,
      ownerUserId: o.ownerUserId,
      status: o.status,
      clock: o.clock,
      log: o.log,
    });
    this.poller = new UpdatePoller({
      store: o.store,
      gateway: o.gateway,
      handler: this.handler,
      clock: o.clock,
      log: o.log,
      ...(o.pollTimeoutS !== undefined ? { pollTimeoutS: o.pollTimeoutS } : {}),
    });
  }

  /** Delivery + digest, no pollers: for replay and tests. Never throws. */
  async tick(): Promise<void> {
    await this.delivery.tick();
    await this.digest.tick();
  }

  start(): void {
    if (this.timer) return;
    this.poller.start();
    const run = (): void => {
      // Skip a beat rather than overlap: a slow Telegram call must not stack ticks.
      if (this.ticking) return;
      this.ticking = this.tick().finally(() => {
        this.ticking = null;
      });
    };
    run();
    this.timer = setInterval(run, this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.poller.stop();
    await this.ticking;
  }
}
