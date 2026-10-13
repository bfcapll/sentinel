/**
 * Transactional-outbox delivery. The scheduler inserts alert rows ('pending'); this class is
 * the only thing that talks to Telegram about them. A P0 is retried forever with capped
 * exponential backoff, so a Telegram outage can delay a P0 but never lose it.
 */
import { renderAlert, renderResolved, renderSuperseded } from '../alerts/render.js';
import type { SentinelConfig } from '../config/schema.js';
import type { Logger } from '../log.js';
import type { AlertRow } from '../store/repos.js';
import type { Store } from '../store/db.js';
import type { Tier } from '../rules/types.js';
import type { Clock } from '../time.js';
import { TelegramError } from './api.js';
import type { BotName, Gateway, InlineButton, SendOptions } from './api.js';
import { ackKeyboard, escapeHtml, fillAlertId, formatAge, toPlain, truncate } from './util.js';

export interface DeliveryOptions {
  store: Store;
  gateway: Gateway;
  config: SentinelConfig['telegram'];
  explorer: SentinelConfig['explorer'];
  clock: Clock;
  log: Logger;
}

const BACKOFF_BASE_S = 5;
const BACKOFF_CAP_S = 300;
/** P1 gives up after this many failed sends; P0 never does. */
const P1_MAX_ATTEMPTS = 20;
const TELEGRAM_MAX = 4096;

export const botForTier = (tier: Tier): BotName => (tier === 'P0' ? 'p0' : tier === 'P1' ? 'p1' : 'p2');

export function backoffSeconds(failures: number): number {
  return Math.min(BACKOFF_CAP_S, BACKOFF_BASE_S * 2 ** Math.min(failures, 10));
}

export class AlertDelivery {
  private readonly store: Store;
  private readonly gateway: Gateway;
  private readonly config: SentinelConfig['telegram'];
  private readonly explorer: SentinelConfig['explorer'];
  private readonly clock: Clock;
  private readonly log: Logger;
  /** In-memory retry state for repeats and resolve notices (rebuilt on restart, which is fine). */
  private readonly retry = new Map<string, { failures: number; notBefore: number }>();

  constructor(o: DeliveryOptions) {
    this.store = o.store;
    this.gateway = o.gateway;
    this.config = o.config;
    this.explorer = o.explorer;
    this.clock = o.clock;
    this.log = o.log;
  }

  private get repos() {
    return this.store.repos;
  }

  private chatId(bot: BotName): string {
    return String(this.config.bots[bot].chat_id);
  }

  private get tz(): string {
    return this.config.digest.timezone;
  }

  /** Stored HTML verbatim (with the id marker filled in); a minimal render if the column is empty. */
  private baseText(a: AlertRow): string {
    if (a.message.trim() !== '') return fillAlertId(a.message, a.id);
    return renderAlert({
      tier: a.tier,
      isOps: a.isOps,
      holding: a.holding,
      conditionKey: a.conditionKey,
      alertId: a.id,
      kind: a.kind,
      exposureUsd: a.exposureUsd,
      exitPathOpen: a.exitPathOpen,
      exitPathReason: 'not recorded',
      context: { title: a.title, ...(a.txHash ? { txHash: a.txHash as `0x${string}` } : {}), ...(a.block !== null ? { block: a.block } : {}) },
      explorer: this.explorer,
      timezone: this.tz,
    });
  }

  /**
   * Send with one fallback: if Telegram rejects the HTML (400 parse error / too long), resend as
   * plain text. A malformed message must never turn into an undeliverable P0.
   */
  private async send(bot: BotName, text: string, opts: SendOptions = {}): Promise<{ messageId: number }> {
    const client = this.gateway[bot];
    const chat = this.chatId(bot);
    try {
      return await client.sendMessage(chat, text, opts);
    } catch (e) {
      if (e instanceof TelegramError && e.status === 400 && /parse entities|too long|can't parse/i.test(e.description)) {
        this.log.warn({ bot, description: e.description }, 'telegram rejected HTML; resending as plain text');
        return client.sendMessage(chat, truncate(toPlain(text), TELEGRAM_MAX - 6), { ...opts, plain: true });
      }
      throw e;
    }
  }

  private failureDelay(e: unknown, failures: number): number {
    const base = backoffSeconds(failures);
    return e instanceof TelegramError && e.retryAfter !== null ? Math.max(base, e.retryAfter) : base;
  }

  private errText(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }

  /** First delivery of pending alerts. P2 rows are digest-only and are never sent here. */
  async deliverPending(): Promise<number> {
    const now = this.clock.now();
    let sent = 0;
    for (const a of this.repos.alert.pendingSend(now)) {
      if (a.tier === 'P2') continue;
      const bot = botForTier(a.tier);
      const keyboard = a.tier === 'P0' ? ackKeyboard(a.id) : undefined;
      try {
        const { messageId } = await this.send(bot, this.baseText(a), keyboard ? { keyboard } : {});
        const at = this.clock.now();
        this.store.tx(() => {
          this.repos.alert.markSent(a.id, this.chatId(bot), messageId, at);
          this.repos.telegramMessage.insert({ alertId: a.id, bot, chatId: this.chatId(bot), messageId, kind: 'open', sentAt: at });
        });
        sent++;
      } catch (e) {
        const at = this.clock.now();
        const giveUp = a.tier !== 'P0' && a.sendAttempts + 1 >= P1_MAX_ATTEMPTS;
        this.repos.alert.markSendFailure(a.id, at + this.failureDelay(e, a.sendAttempts), giveUp);
        const fields = { alertId: a.id, tier: a.tier, attempt: a.sendAttempts + 1, err: this.errText(e) };
        if (giveUp) this.log.error(fields, 'alert delivery failed permanently; giving up');
        else this.log.warn(fields, 'alert delivery failed; will retry');
      }
    }
    return sent;
  }

  /** P0 re-send until ACK, one live button message per alert, one repeat per global interval. */
  async runRepeats(): Promise<number> {
    const now = this.clock.now();
    const cfg = this.config;
    let repeats = 0;
    for (const a of this.repos.alert.openP0()) {
      if (a.snoozedUntil !== null && a.snoozedUntil > now) continue;
      if (a.firedAt + cfg.repeat_cap_hours * 3600 <= now) continue;
      if ((a.lastSentAt ?? a.firedAt) + cfg.repeat_minutes * 60 > now) continue;
      const state = this.retry.get(`repeat:${a.id}`);
      if (state && state.notBefore > now) continue;
      // Re-read the clock per alert: the limiter must see repeats sent earlier in this very loop.
      const nowLoop = this.clock.now();
      const gap = cfg.global_repeat_min_interval_s;
      if (gap > 0 && this.repos.alert.recentRepeatCount(nowLoop - gap) > 0) continue;

      const prefix = `🔁 <b>repeat #${a.repeatCount + 1}</b> — unacknowledged since ${formatAge(nowLoop - a.firedAt)}`;
      const text = `${prefix}\n${this.baseText(a)}`;
      const previous = this.repos.telegramMessage.liveForAlert(a.id);
      try {
        const { messageId } = await this.send('p0', text, { keyboard: ackKeyboard(a.id) });
        const at = this.clock.now();
        this.store.tx(() => {
          this.repos.alert.recordRepeat(a.id, this.chatId('p0'), messageId, at);
          this.repos.telegramMessage.insert({ alertId: a.id, bot: 'p0', chatId: this.chatId('p0'), messageId, kind: 'repeat', sentAt: at });
        });
        this.retry.delete(`repeat:${a.id}`);
        repeats++;
      } catch (e) {
        this.noteFailure(`repeat:${a.id}`, e);
        this.log.warn({ alertId: a.id, err: this.errText(e) }, 'P0 repeat failed; will retry');
        continue;
      }
      // Only after the new message is out do we strip the old buttons, so a failed send never
      // leaves the operator with no live ACK button.
      for (const m of previous) {
        try {
          await this.gateway[m.bot].editMessageText(m.chatId, m.messageId, renderSuperseded(a.id), { keyboard: null });
          this.repos.telegramMessage.retire(m.id);
        } catch (e) {
          this.log.warn({ alertId: a.id, messageId: m.messageId, err: this.errText(e) }, 'could not mark old P0 message superseded');
        }
      }
    }
    return repeats;
  }

  private noteFailure(key: string, e: unknown): void {
    const failures = (this.retry.get(key)?.failures ?? 0) + 1;
    this.retry.set(key, { failures, notBefore: this.clock.now() + this.failureDelay(e, failures - 1) });
  }

  /** "RESOLVED" reply (threaded under the latest message) plus keyboard cleanup for P0. */
  async deliverResolveNotices(): Promise<number> {
    const now = this.clock.now();
    let n = 0;
    for (const a of this.repos.alert.pendingResolveNotice()) {
      if (a.supersededBy !== null) {
        this.repos.alert.suppressResolveNotice(a.id);
        continue;
      }
      const state = this.retry.get(`resolve:${a.id}`);
      if (state && state.notBefore > now) continue;
      const bot = botForTier(a.tier);
      const reason = a.resolveReason ?? 'condition cleared';
      const text = renderResolved({
        holding: a.holding,
        conditionKey: a.conditionKey,
        reason,
        tier: a.tier,
        resolvedAt: a.resolvedAt ?? now,
        timezone: this.tz,
      });
      try {
        await this.send(bot, text, a.telegramMsgId !== null ? { replyToMessageId: a.telegramMsgId } : {});
      } catch (e) {
        this.noteFailure(`resolve:${a.id}`, e);
        this.log.warn({ alertId: a.id, err: this.errText(e) }, 'RESOLVED notice failed; will retry');
        continue;
      }
      this.repos.alert.markResolveNoticeSent(a.id);
      this.retry.delete(`resolve:${a.id}`);
      n++;
      if (a.tier !== 'P0') continue;
      const resolvedText = `${this.baseText(a)}\n\n✅ <b>RESOLVED</b> — ${escapeHtml(truncate(reason, 300))}`;
      for (const m of this.repos.telegramMessage.liveForAlert(a.id)) {
        try {
          const keyboard: InlineButton[][] | null = null;
          await this.gateway[m.bot].editMessageText(m.chatId, m.messageId, resolvedText, { keyboard });
          this.repos.telegramMessage.retire(m.id);
        } catch (e) {
          this.log.warn({ alertId: a.id, messageId: m.messageId, err: this.errText(e) }, 'could not strip keyboard on resolved P0');
        }
      }
    }
    return n;
  }

  /** One delivery pass; never throws. */
  async tick(): Promise<void> {
    for (const [name, step] of [
      ['deliverPending', () => this.deliverPending()],
      ['runRepeats', () => this.runRepeats()],
      ['deliverResolveNotices', () => this.deliverResolveNotices()],
    ] as const) {
      try {
        await step();
      } catch (e) {
        this.log.error({ step: name, err: this.errText(e) }, 'telegram delivery step failed');
      }
    }
  }
}
