/**
 * Inbound side: ACK / Snooze buttons, /ack, /status, /help. Every state-changing path is
 * gated on (owner user id AND the chat the bot is configured for): a button forwarded into
 * another chat, or a stranger added to the group, can neither ACK nor read status.
 */
import { renderAcked, renderSuperseded } from '../alerts/render.js';
import type { SentinelConfig } from '../config/schema.js';
import type { StatusProvider } from '../health/status.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/db.js';
import type { AlertRow } from '../store/repos.js';
import type { Clock } from '../time.js';
import type { BotName, Gateway, TgCallbackQuery, TgMessage, TgUpdate, TgUser } from './api.js';
import { aliveLine, exposureLine, providerLines } from './statusfmt.js';
import { ackKeyboard, escapeHtml, fillAlertId, fitEscaped, formatAge, formatLocal, splitMessage } from './util.js';

export interface UpdateHandlerOptions {
  store: Store;
  gateway: Gateway;
  config: SentinelConfig['telegram'];
  ownerUserId: number;
  status: StatusProvider;
  clock: Clock;
  log: Logger;
}

type Via = 'button' | 'command';
type AlertState = 'unknown' | 'resolved' | 'superseded' | 'acked' | 'ok';

const HELP = [
  '<b>Sentinel</b>',
  '/ack &lt;id&gt; — acknowledge a P0 alert (fallback for the ACK button)',
  '/ack — list open unacknowledged P0 alerts',
  '/status — system status (P1 bot only)',
  '/help — this text',
].join('\n');

function userLabel(u: TgUser): string {
  return u.username ? `@${u.username}` : (u.first_name ?? `user ${u.id}`);
}

export class UpdateHandler {
  private readonly store: Store;
  private readonly gateway: Gateway;
  private readonly config: SentinelConfig['telegram'];
  private readonly ownerUserId: number;
  private readonly status: StatusProvider;
  private readonly clock: Clock;
  private readonly log: Logger;

  constructor(o: UpdateHandlerOptions) {
    this.store = o.store;
    this.gateway = o.gateway;
    this.config = o.config;
    this.ownerUserId = o.ownerUserId;
    this.status = o.status;
    this.clock = o.clock;
    this.log = o.log;
  }

  private get repos() {
    return this.store.repos;
  }

  private get tz(): string {
    return this.config.digest.timezone;
  }

  private authorised(bot: BotName, userId: number | undefined, chatId: number | undefined): boolean {
    return userId === this.ownerUserId && chatId !== undefined && String(chatId) === String(this.config.bots[bot].chat_id);
  }

  async handle(bot: BotName, update: TgUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(bot, update.callback_query);
    if (update.message?.text !== undefined) return this.handleMessage(bot, update.message);
  }

  /* ------------------------------------------------------------ callbacks */

  private async handleCallback(bot: BotName, cb: TgCallbackQuery): Promise<void> {
    const client = this.gateway[bot];
    const chatId = cb.message?.chat.id;
    if (!this.authorised(bot, cb.from.id, chatId)) {
      this.log.warn({ bot, userId: cb.from.id, chatId }, 'rejected callback from unauthorised user or chat');
      await this.safe(() => client.answerCallbackQuery(cb.id, 'Not authorised'), 'answer reject');
      return;
    }
    const m = /^(ack|snooze):(\d+)$/.exec(cb.data ?? '');
    if (!m || !cb.message) {
      await this.safe(() => client.answerCallbackQuery(cb.id, 'Unknown action'), 'answer unknown');
      return;
    }
    const action = m[1];
    const alert = this.repos.alert.get(Number(m[2]));
    const state = this.classify(alert);
    const pressed = { bot, chatId: cb.message.chat.id, messageId: cb.message.message_id };

    if (alert === undefined) {
      await this.safe(() => client.answerCallbackQuery(cb.id, 'Unknown alert'), 'answer unknown alert');
      return;
    }
    if (state === 'resolved' || state === 'superseded') {
      const text =
        state === 'superseded' && alert.supersededBy !== null
          ? renderSuperseded(alert.id, alert.supersededBy)
          : `${fillAlertId(alert.message, alert.id)}\n\n✅ <b>RESOLVED</b>`;
      await this.safe(() => client.editMessageText(pressed.chatId, pressed.messageId, text, { keyboard: null }), 'strip keyboard');
      await this.safe(() => client.answerCallbackQuery(cb.id, 'This alert is already resolved'), 'answer resolved');
      return;
    }

    if (action === 'ack') {
      const r = this.ack(alert, cb.from.id, 'button', userLabel(cb.from));
      await this.editAll(alert, r.text, null, pressed);
      await this.safe(() => client.answerCallbackQuery(cb.id, r.fresh ? 'Acknowledged' : 'Already acknowledged'), 'answer ack');
      return;
    }

    // snooze
    if (state === 'acked') {
      await this.safe(() => client.answerCallbackQuery(cb.id, 'Already acknowledged'), 'answer snooze acked');
      return;
    }
    const now = this.clock.now();
    const until = now + this.config.snooze_minutes * 60;
    this.repos.alert.setSnooze(alert.id, until);
    const text = `${fillAlertId(alert.message, alert.id)}\n\n😴 <b>Snoozed</b> until ${formatLocal(until, this.tz)}`;
    await this.editAll(alert, text, ackKeyboard(alert.id), pressed);
    await this.safe(() => client.answerCallbackQuery(cb.id, `Snoozed for ${this.config.snooze_minutes} min`), 'answer snooze');
  }

  private classify(a: AlertRow | undefined): AlertState {
    if (a === undefined) return 'unknown';
    if (a.resolvedAt !== null) return 'resolved';
    if (a.supersededBy !== null) return 'superseded';
    if (a.ackedAt !== null) return 'acked';
    return 'ok';
  }

  /**
   * Record the ACK (idempotent) and return the text its message should now show. The live
   * messages are retired because an acknowledged alert has nothing left to press.
   */
  private ack(alert: AlertRow, userId: number, via: Via, label: string): { fresh: boolean; text: string } {
    const now = this.clock.now();
    const fresh = alert.ackedAt === null;
    if (fresh) {
      this.store.tx(() => {
        this.repos.ack.insert(alert.id, userId, via, now);
        this.repos.alert.markAcked(alert.id, now);
      });
    }
    const at = fresh ? now : (alert.ackedAt ?? now);
    return { fresh, text: renderAcked(fillAlertId(alert.message, alert.id), label, at, this.tz) };
  }

  /** Edit every tracked live message of the alert (plus the one that was pressed). Failures are logged only. */
  private async editAll(
    alert: AlertRow,
    text: string,
    keyboard: ReturnType<typeof ackKeyboard> | null,
    pressed?: { bot: BotName; chatId: number; messageId: number },
  ): Promise<void> {
    const live = this.repos.telegramMessage.liveForAlert(alert.id);
    const targets = new Map<string, { bot: BotName; chatId: string | number; messageId: number; rowId: number | null }>();
    for (const m of live) targets.set(`${m.chatId}:${m.messageId}`, { bot: m.bot, chatId: m.chatId, messageId: m.messageId, rowId: m.id });
    if (pressed) {
      const key = `${pressed.chatId}:${pressed.messageId}`;
      if (!targets.has(key)) targets.set(key, { bot: pressed.bot, chatId: pressed.chatId, messageId: pressed.messageId, rowId: null });
    }
    for (const t of targets.values()) {
      const ok = await this.safe(() => this.gateway[t.bot].editMessageText(t.chatId, t.messageId, text, { keyboard }), 'edit message');
      // An ACKed message is final; a snoozed one keeps its keyboard and stays live.
      if (ok && keyboard === null && t.rowId !== null) this.repos.telegramMessage.retire(t.rowId);
    }
  }

  /* ------------------------------------------------------------ messages */

  private async handleMessage(bot: BotName, msg: TgMessage): Promise<void> {
    if (!this.authorised(bot, msg.from?.id, msg.chat.id)) {
      this.log.info({ bot, userId: msg.from?.id, chatId: msg.chat.id }, 'ignoring message from unauthorised user or chat');
      return;
    }
    const m = /^\/(\w+)(?:@\w+)?(?:\s+([\s\S]*))?$/.exec((msg.text ?? '').trim());
    if (!m) return;
    const arg = (m[2] ?? '').trim();
    switch ((m[1] ?? '').toLowerCase()) {
      case 'ack':
        return this.cmdAck(bot, msg, arg);
      case 'status':
        if (bot !== 'p1') return this.reply(bot, msg, 'Use /status on the P1 bot.');
        return this.cmdStatus(bot, msg);
      case 'start':
      case 'help':
        return this.reply(bot, msg, HELP);
      default:
        return;
    }
  }

  private async reply(bot: BotName, msg: TgMessage, text: string): Promise<void> {
    for (const chunk of splitMessage(text, 4000)) {
      await this.safe(() => this.gateway[bot].sendMessage(msg.chat.id, chunk, { replyToMessageId: msg.message_id }), 'reply');
    }
  }

  private async cmdAck(bot: BotName, msg: TgMessage, arg: string): Promise<void> {
    if (arg === '') {
      const open = this.repos.alert.openP0();
      if (open.length === 0) return this.reply(bot, msg, 'No open unacknowledged P0 alerts.');
      const lines = open.map((a) => `• #${a.id} — <code>${escapeHtml(a.holding)}</code> — ${escapeHtml(fitEscaped(a.title, 100))}`);
      return this.reply(bot, msg, `Open unacknowledged P0 alerts:\n${lines.join('\n')}\n\nUse /ack &lt;id&gt;.`);
    }
    if (!/^#?\d+$/.test(arg)) return this.reply(bot, msg, 'Usage: /ack &lt;alert id&gt;');
    const id = Number(arg.replace('#', ''));
    const alert = this.repos.alert.get(id);
    switch (this.classify(alert)) {
      case 'unknown':
        return this.reply(bot, msg, `Unknown alert id #${id}.`);
      case 'resolved':
        return this.reply(bot, msg, `Alert #${id} is already resolved; nothing to acknowledge.`);
      case 'superseded':
        return this.reply(bot, msg, `Alert #${id} was superseded by #${alert?.supersededBy ?? '?'}; acknowledge that one instead.`);
      case 'acked':
        return this.reply(bot, msg, `Alert #${id} is already acknowledged.`);
      case 'ok':
        break;
    }
    if (!alert || !msg.from) return;
    const r = this.ack(alert, msg.from.id, 'command', userLabel(msg.from));
    await this.editAll(alert, r.text, null);
    await this.reply(bot, msg, `✅ Alert #${id} acknowledged. Repeats stopped.`);
  }

  private async cmdStatus(bot: BotName, msg: TgMessage): Promise<void> {
    const s = this.status.snapshot();
    const open = this.repos.condition.listOpen();
    const lines: string[] = [`<b>Sentinel status</b> — ${formatLocal(s.now, this.tz)}`, aliveLine(s), ''];
    lines.push('<b>Providers</b>', ...providerLines(s), '');
    lines.push(
      s.lastCycle
        ? `<b>Last cycle</b>: block ${s.lastCycle.block.toLocaleString('en-US')}, ${s.lastCycle.durationMs} ms, ${formatAge(s.now - s.lastCycle.at)} ago`
        : '<b>Last cycle</b>: none yet',
      '',
    );
    lines.push(`<b>Open conditions</b> (${open.length})`);
    if (open.length === 0) lines.push('• none');
    for (const c of open) {
      const tier = c.tier ?? '?';
      const since = c.openedAt === null ? 'unknown' : `${formatLocal(c.openedAt, this.tz)} (${formatAge(s.now - c.openedAt)})`;
      lines.push(`• <b>${tier}</b> <code>${escapeHtml(fitEscaped(c.key, 120))}</code> — since ${since}`);
    }
    lines.push('', '<b>Exposure</b>');
    if (s.holdings.length === 0) lines.push('• no holdings');
    for (const h of s.holdings) {
      lines.push(`• ${exposureLine(h)}`);
    }
    lines.push('', '<b>Watchers</b> (consecutive errors)');
    if (s.watchers.length === 0) lines.push('• none reported');
    for (const w of s.watchers) {
      lines.push(`• ${escapeHtml(w.name)}: ${w.consecutiveErrors}${w.consecutiveErrors > 0 && w.lastError ? ` — ${escapeHtml(fitEscaped(w.lastError, 120))}` : ''}`);
    }
    await this.reply(bot, msg, lines.join('\n'));
  }

  /** Telegram-side failures never abort state handling; returns whether the call succeeded. */
  private async safe(fn: () => Promise<unknown>, what: string): Promise<boolean> {
    try {
      await fn();
      return true;
    } catch (e) {
      this.log.warn({ what, err: e instanceof Error ? e.message : String(e) }, 'telegram call failed');
      return false;
    }
  }
}
