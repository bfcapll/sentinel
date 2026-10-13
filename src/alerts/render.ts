/**
 * Pure message rendering (Telegram HTML parse_mode). Every alert carries the same mandatory
 * lines, always present, with explicit words when a value is unknown, so a glance at the
 * phone answers: which holding, how much money, can I still exit, what happened, where.
 */
import type { AlertContext, Tier } from '../rules/types.js';
import { ALERT_ID_MARKER, escapeAttr, escapeHtml, fitEscaped, formatLocal, formatUtc, resolveZone } from '../telegram/util.js';

export interface RenderInput {
  tier: Tier;
  isOps: boolean;
  holding: string;
  conditionKey: string;
  alertId?: number;
  kind: 'open' | 'escalation';
  exposureUsd: number | null;
  /** e.g. "main: 123,456.78 steakUSDC" */
  exposureNote?: string;
  exitPathOpen: boolean | null;
  exitPathReason: string;
  context: AlertContext;
  explorer: { tx_url: string; block_url: string; address_url: string };
  /** IANA zone or 'local'. */
  timezone: string;
  repeatCount?: number;
}

/**
 * Hard ceiling for rendered alerts. Telegram's limit is 4096; the headroom is for the repeat
 * prefix and the ACK / RESOLVED lines appended later when the message is edited.
 */
const MAX_LEN = 4000;

const BADGE: Record<Tier, string> = { P0: '🔴', P1: '🟠', P2: '🟡' };

export function formatUsd(n: number | null): string {
  if (n === null || !Number.isFinite(n)) return 'unknown';
  const body = Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return `${n < 0 && body !== '0.00' ? '-' : ''}$${body}`;
}

const shortHash = (h: string): string => (h.length > 20 ? `${h.slice(0, 10)}…${h.slice(-8)}` : h);

function link(url: string, label: string): string {
  return `<a href="${escapeAttr(url)}">${escapeHtml(label)}</a>`;
}

export function renderAlert(i: RenderInput): string {
  const ctx = i.context;
  const title = escapeHtml(fitEscaped(ctx.title, 300));
  const holding = escapeHtml(fitEscaped(i.holding, 120));
  const key = escapeHtml(fitEscaped(i.conditionKey, 160));
  const reason = escapeHtml(fitEscaped(i.exitPathReason.trim() || 'no reason given', 400));
  const note = i.exposureNote ? ` (${escapeHtml(fitEscaped(i.exposureNote, 120))})` : '';

  const badge = `${BADGE[i.tier]} <b>${i.isOps ? 'OPS ' : ''}${i.tier}</b>`;
  const header = `${badge} — <b>${title}</b>${i.kind === 'escalation' ? ' ⬆️ escalated' : ''}`;

  const exposure = i.exposureUsd === null || !Number.isFinite(i.exposureUsd) ? 'unknown' : formatUsd(i.exposureUsd);
  const exitLine =
    i.exitPathOpen === null ? `<b>Exit path: UNKNOWN</b> (${reason})` : `<b>Exit path: ${i.exitPathOpen ? 'OPEN' : 'CLOSED'}</b> — ${reason}`;

  const txLine = ctx.txHash
    ? `Tx: ${link(i.explorer.tx_url.replace('{hash}', ctx.txHash), shortHash(ctx.txHash))}`
    : 'Tx: no tx (detected by state read)';
  const blockLine =
    ctx.block === undefined
      ? 'Block: unknown'
      : `Block: ${link(i.explorer.block_url.replace('{number}', String(ctx.block)), String(ctx.block))}`;
  const zone = resolveZone(i.timezone);
  const etaLine =
    ctx.eta === undefined ? 'ETA: n/a' : `ETA: ${formatUtc(ctx.eta)} / ${formatLocal(ctx.eta, zone)} (${escapeHtml(zone)})`;
  const contractLine = ctx.address ? `Contract: ${link(i.explorer.address_url.replace('{address}', ctx.address), ctx.address)}` : null;

  const idText = i.alertId === undefined ? ALERT_ID_MARKER : `alert #${i.alertId}`;
  const repeat = i.repeatCount && i.repeatCount > 0 ? `🔁 repeat #${i.repeatCount}\n` : '';
  const footer = `${repeat}${idText} · <code>${key}</code>`;

  const build = (decoded: string, detail: string): string =>
    [
      header,
      `Holding: <code>${holding}</code>`,
      `$ exposure: ${exposure}${note}`,
      exitLine,
      `Action: ${decoded}`,
      txLine,
      blockLine,
      etaLine,
      contractLine,
      detail === '' ? null : `Detail: ${detail}`,
      footer,
    ]
      .filter((l): l is string => l !== null)
      .join('\n');

  // Budget what is left for the free-text fields after all fixed lines are laid out.
  const rawDecoded = ctx.decoded?.trim() ?? '';
  const rawDetail = ctx.detail?.trim() ?? '';
  const fallbackDecoded = 'n/a (state-read detection)';
  const decodedEsc = escapeHtml(rawDecoded === '' ? fallbackDecoded : rawDecoded);
  const detailEsc = escapeHtml(rawDetail);

  const full = build(decodedEsc, detailEsc);
  if (full.length <= MAX_LEN) return full;

  const overhead = build(rawDecoded === '' ? fallbackDecoded : 'x', rawDetail === '' ? '' : 'x').length - (rawDecoded === '' ? 0 : 1) - (rawDetail === '' ? 0 : 1);
  const budget = Math.max(2, MAX_LEN - overhead);
  let decBudget: number;
  let detBudget: number;
  if (rawDecoded === '') {
    decBudget = 0;
    detBudget = budget;
  } else if (rawDetail === '') {
    decBudget = budget;
    detBudget = 0;
  } else if (decodedEsc.length <= budget / 2) {
    decBudget = decodedEsc.length;
    detBudget = budget - decBudget;
  } else if (detailEsc.length <= budget / 2) {
    detBudget = detailEsc.length;
    decBudget = budget - detBudget;
  } else {
    decBudget = Math.floor(budget / 2);
    detBudget = budget - decBudget;
  }
  const decoded = rawDecoded === '' ? fallbackDecoded : escapeHtml(fitEscaped(rawDecoded, Math.max(1, decBudget)));
  const detail = rawDetail === '' ? '' : escapeHtml(fitEscaped(rawDetail, Math.max(1, detBudget)));
  return build(decoded, detail);
}

export function renderResolved(i: {
  holding: string;
  conditionKey: string;
  reason: string;
  tier: Tier;
  resolvedAt: number;
  timezone: string;
}): string {
  const zone = resolveZone(i.timezone);
  return [
    `✅ <b>RESOLVED</b> — ${BADGE[i.tier]} ${i.tier}`,
    `Holding: <code>${escapeHtml(fitEscaped(i.holding, 120))}</code>`,
    `Condition: <code>${escapeHtml(fitEscaped(i.conditionKey, 160))}</code>`,
    `Reason: ${escapeHtml(fitEscaped(i.reason.trim() || 'condition cleared', 500))}`,
    `At: ${formatUtc(i.resolvedAt)} / ${formatLocal(i.resolvedAt, zone)}`,
  ].join('\n');
}

export function renderSuperseded(alertId: number, byAlertId?: number): string {
  return byAlertId === undefined
    ? `⏭ <b>Superseded</b> — alert #${alertId} was re-sent below (latest message is the live one).`
    : `⏭ <b>Superseded</b> — alert #${alertId} was replaced by alert #${byAlertId}.`;
}

/** `base` is already HTML (a previously rendered alert); the ACK line is appended to it. */
export function renderAcked(base: string, userLabel: string, at: number, tz: string): string {
  return `${base}\n\n✅ <b>ACK</b> by ${escapeHtml(userLabel)} at ${formatLocal(at, tz)}`;
}
