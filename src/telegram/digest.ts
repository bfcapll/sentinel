/**
 * Daily digest on the P2 bot. "Due" means: local time (digest.timezone) is at or past
 * digest.time AND today's local date is not the one recorded in kv, so a restart after 09:00
 * still sends exactly once and a restart never sends twice.
 */
import { formatUsd } from '../alerts/render.js';
import type { SentinelConfig } from '../config/schema.js';
import type { StatusProvider, StatusSnapshot } from '../health/status.js';
import type { Logger } from '../log.js';
import type { Store } from '../store/db.js';
import type { AlertRow } from '../store/repos.js';
import type { ConditionState } from '../rules/types.js';
import type { Clock } from '../time.js';
import { TelegramError } from './api.js';
import type { Gateway } from './api.js';
import { aliveLine, exposureLine, providerLines, rpcSummary, watcherLines } from './statusfmt.js';
import { escapeHtml, fitEscaped, formatAge, formatLocal, localDate, localMinutesOfDay, splitMessage, toPlain, truncate } from './util.js';

export interface DigestOptions {
  store: Store;
  gateway: Gateway;
  config: SentinelConfig['telegram'];
  status: StatusProvider;
  clock: Clock;
  log: Logger;
}

export const KV_LAST_DATE = 'digest.last_date';
export const KV_LAST_SENT_AT = 'digest.last_sent_at';

const CHUNK_MAX = 4000;
const RETRY_AFTER_FAILURE_S = 60;
const BADGE = { P0: '🔴', P1: '🟠', P2: '🟡' } as const;

export class DigestJob {
  private readonly o: DigestOptions;
  /** A digest that was only partly delivered; finished on the next tick without re-sending sent parts. */
  private inFlight: { date: string; chunks: string[]; sent: number } | null = null;
  private notBefore = 0;

  constructor(o: DigestOptions) {
    this.o = o;
  }

  private get repos() {
    return this.o.store.repos;
  }

  /** True when a digest was fully delivered by this call. Never throws. */
  async tick(): Promise<boolean> {
    try {
      return await this.run();
    } catch (e) {
      this.o.log.error({ err: e instanceof Error ? e.message : String(e) }, 'digest tick failed');
      return false;
    }
  }

  private async run(): Promise<boolean> {
    const { config, clock } = this.o;
    const now = clock.now();
    const tz = config.digest.timezone;
    const today = localDate(now, tz);
    if (this.repos.kv.get(KV_LAST_DATE) === today) return false;
    const [hh, mm] = config.digest.time.split(':').map(Number);
    if (localMinutesOfDay(now, tz) < (hh ?? 0) * 60 + (mm ?? 0)) return false;
    if (now < this.notBefore) return false;

    if (this.inFlight && this.inFlight.date !== today) this.inFlight = null;
    if (!this.inFlight) {
      const since = Number(this.repos.kv.get(KV_LAST_SENT_AT) ?? now - 86_400);
      const text = this.build(now, today, Number.isFinite(since) ? since : now - 86_400, this.o.status.snapshot());
      this.inFlight = { date: today, chunks: splitMessage(text, CHUNK_MAX), sent: 0 };
    }

    const chat = String(config.bots.p2.chat_id);
    const job = this.inFlight;
    while (job.sent < job.chunks.length) {
      const chunk = job.chunks[job.sent] ?? '';
      try {
        await this.send(chat, chunk);
      } catch (e) {
        this.notBefore = clock.now() + RETRY_AFTER_FAILURE_S;
        this.o.log.warn({ sent: job.sent, total: job.chunks.length, err: e instanceof Error ? e.message : String(e) }, 'digest send failed; will retry');
        return false;
      }
      job.sent++;
    }
    this.inFlight = null;
    this.repos.kv.set(KV_LAST_DATE, today, now);
    this.repos.kv.set(KV_LAST_SENT_AT, String(now), now);
    return true;
  }

  private async send(chat: string, html: string): Promise<void> {
    const client = this.o.gateway.p2;
    try {
      await client.sendMessage(chat, html);
    } catch (e) {
      if (e instanceof TelegramError && e.status === 400 && /parse entities|can't parse/i.test(e.description)) {
        await client.sendMessage(chat, truncate(toPlain(html), 4090), { plain: true });
        return;
      }
      throw e;
    }
  }

  private build(now: number, today: string, since: number, s: StatusSnapshot): string {
    const tz = this.o.config.digest.timezone;
    const alerts = this.repos.alert.digestSince(since);
    const open = this.repos.condition.listOpen();
    const stillOpen = this.repos.alert.stillOpen();
    const out: string[] = [];

    out.push(`📋 <b>Sentinel daily digest</b> — ${today} (${formatLocal(now, tz)})`, aliveLine(s), '');

    out.push('<b>Still open — P0 / P1</b>');
    const hot = stillOpen.filter((a) => a.tier !== 'P2' && a.sendState !== 'digest');
    if (hot.length === 0) out.push('• none');
    for (const a of hot) out.push(`• ${this.alertLine(a, now)}`);
    out.push('');

    const holdingIds = new Set<string>(s.holdings.map((h) => h.id));
    for (const c of open) if (!isOpsKey(c, alerts)) holdingIds.add(c.holding);
    for (const a of alerts) if (!a.isOps) holdingIds.add(a.holding);
    const byId = new Map(s.holdings.map((h) => [h.id, h]));
    for (const id of [...holdingIds].sort()) {
      const h = byId.get(id);
      out.push(h ? `📦 <b>${escapeHtml(id)}</b>` : `📦 <b>${escapeHtml(id)}</b> (no position data)`);
      out.push(h ? `  ${exposureLine(h)}` : `  $ exposure: ${formatUsd(null)}`);
      const conds = open.filter((c) => c.holding === id);
      const p2 = alerts.filter((a) => a.holding === id && !a.isOps && a.tier === 'P2' && a.firedAt > since);
      const closed = alerts.filter((a) => a.holding === id && !a.isOps && a.resolvedAt !== null && a.resolvedAt > since);
      if (conds.length === 0) out.push('  open conditions: none');
      for (const c of conds) out.push(`  open: ${this.condLine(c, now)}`);
      for (const a of p2) out.push(`  🟡 P2 opened: ${escapeHtml(fitEscaped(a.title, 140))} (${formatLocal(a.firedAt, tz)})`);
      for (const a of closed) {
        out.push(`  ✔ closed: ${escapeHtml(fitEscaped(a.title, 120))} — ${escapeHtml(fitEscaped(a.resolveReason ?? 'cleared', 120))}`);
      }
      out.push('');
    }
    if (holdingIds.size === 0) out.push('<i>No holdings configured.</i>', '');

    out.push('<b>OPS / watcher health</b>', `• ${rpcSummary(s)}`, ...providerLines(s), ...watcherLines(s));
    const ops = alerts.filter((a) => a.isOps);
    if (ops.length === 0) out.push('• no OPS alerts since the previous digest');
    for (const a of ops) {
      const state = a.resolvedAt === null ? 'STILL OPEN' : `resolved ${formatLocal(a.resolvedAt, tz)}`;
      out.push(`• ${BADGE[a.tier]} OPS ${a.tier}: ${escapeHtml(fitEscaped(a.title, 140))} — ${state}`);
    }
    return out.join('\n');
  }

  private alertLine(a: AlertRow, now: number): string {
    const ack = a.tier === 'P0' ? (a.ackedAt !== null ? ', ACKed' : ', UNACKED') : '';
    const who = a.isOps ? 'OPS ' : '';
    return (
      `${BADGE[a.tier]} ${who}${a.tier} #${a.id} <code>${escapeHtml(fitEscaped(a.holding, 80))}</code> — ${escapeHtml(fitEscaped(a.title, 140))} ` +
      `(<code>${escapeHtml(fitEscaped(a.conditionKey, 100))}</code>, open ${formatAge(now - a.firedAt)}${ack})`
    );
  }

  private condLine(c: ConditionState, now: number): string {
    const title = c.context?.title ? ` — ${escapeHtml(fitEscaped(c.context.title, 120))}` : '';
    const since = c.openedAt === null ? '' : ` (open ${formatAge(now - c.openedAt)})`;
    return `${c.tier ?? '?'} <code>${escapeHtml(fitEscaped(c.key, 100))}</code>${title}${since}`;
  }
}

/** Ops conditions are reported in the OPS section, not under a holding. */
function isOpsKey(c: ConditionState, alerts: AlertRow[]): boolean {
  return c.watcher === 'ops' || c.rule.startsWith('ops.') || alerts.some((a) => a.isOps && a.conditionKey === c.key);
}
