/**
 * Small pure helpers shared by the renderer, delivery, command handler and digest:
 * HTML escaping, truncation, timezone-aware formatting and message splitting.
 */
import type { InlineButton } from './api.js';

const ELLIPSIS = '…';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Escape for use inside a double-quoted HTML attribute (Telegram supports &quot;). */
export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Truncate to at most `max` code units, ending with an ellipsis when something was cut. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 0) return '';
  let cut = s.slice(0, max - 1);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // never leave half a surrogate pair
  return cut + ELLIPSIS;
}

/** Truncate raw text so that its HTML-escaped form is at most `maxEscaped` long. */
export function fitEscaped(raw: string, maxEscaped: number): string {
  if (maxEscaped <= 0) return '';
  let k = Math.min(raw.length, maxEscaped);
  let out = truncate(raw, k);
  while (k > 1 && escapeHtml(out).length > maxEscaped) {
    const over = escapeHtml(out).length - maxEscaped;
    k = Math.max(1, k - Math.max(1, Math.floor(over / 4)));
    out = truncate(raw, k);
  }
  return out;
}

/* ------------------------------------------------------------------ time */

/** Resolve 'local' to the host IANA zone; unknown zones fall back to UTC rather than throwing. */
export function resolveZone(tz: string): string {
  const zone = tz === 'local' ? Intl.DateTimeFormat().resolvedOptions().timeZone : tz;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return zone;
  } catch {
    return 'UTC';
  }
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function zonedParts(ts: number, tz: string): ZonedParts {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: resolveZone(tz),
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const get = (type: string): number => Number(fmt.formatToParts(new Date(ts * 1000)).find((p) => p.type === type)?.value ?? '0');
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') };
}

const p2 = (n: number): string => String(n).padStart(2, '0');

/** YYYY-MM-DD in the zone. */
export function localDate(ts: number, tz: string): string {
  const p = zonedParts(ts, tz);
  return `${p.year}-${p2(p.month)}-${p2(p.day)}`;
}

export function localMinutesOfDay(ts: number, tz: string): number {
  const p = zonedParts(ts, tz);
  return p.hour * 60 + p.minute;
}

function zoneAbbrev(ts: number, zone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' }).formatToParts(new Date(ts * 1000));
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? zone;
}

/** "2026-10-14 12:00 UTC" */
export function formatUtc(ts: number): string {
  return formatLocal(ts, 'UTC');
}

/** "2026-10-14 08:00 EDT" in the given zone ('local' = host zone). */
export function formatLocal(ts: number, tz: string): string {
  const zone = resolveZone(tz);
  const p = zonedParts(ts, zone);
  return `${p.year}-${p2(p.month)}-${p2(p.day)} ${p2(p.hour)}:${p2(p.minute)} ${zoneAbbrev(ts, zone)}`;
}

/** Compact duration: 45s, 12m, 1h 05m, 2d 3h. */
export function formatAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${p2(m % 60)}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/* ------------------------------------------------------------------ messages */

/** Cut at `max` without leaving a half tag or half entity behind. */
function safeCut(s: string, max: number): string {
  let end = Math.min(max, s.length);
  const slice = s.slice(0, end);
  if (slice.lastIndexOf('<') > slice.lastIndexOf('>')) end = slice.lastIndexOf('<');
  const amp = slice.lastIndexOf('&', end);
  if (amp >= 0 && end - amp <= 8 && !slice.slice(amp, end).includes(';')) end = amp;
  return end > 0 ? s.slice(0, end) : s.slice(0, max);
}

/**
 * Split on line boundaries into chunks of at most `max` chars. Callers keep every HTML tag
 * within a single line, so chunks are independently valid.
 */
export function splitMessage(text: string, max = 4000): string[] {
  const lines: string[] = [];
  for (let line of text.split('\n')) {
    while (line.length > max) {
      const piece = safeCut(line, max);
      lines.push(piece);
      line = line.slice(piece.length);
    }
    lines.push(line);
  }
  const out: string[] = [];
  let cur: string | null = null;
  for (const line of lines) {
    if (cur === null) cur = line;
    else if (cur.length + 1 + line.length > max) {
      out.push(cur);
      cur = line;
    } else cur += '\n' + line;
  }
  if (cur !== null && cur.trim() !== '') out.push(cur);
  return out;
}

/** Strip tags and unescape entities: the last-resort fallback when Telegram rejects the HTML. */
export function toPlain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

/* ------------------------------------------------------------------ alert helpers */

/** The scheduler renders before the row id exists; the footer carries this marker until delivery. */
export const ALERT_ID_MARKER = 'alert #?';

export function fillAlertId(message: string, id: number): string {
  const i = message.lastIndexOf(ALERT_ID_MARKER);
  if (i < 0) return message;
  return message.slice(0, i) + `alert #${id}` + message.slice(i + ALERT_ID_MARKER.length);
}

export function ackKeyboard(alertId: number): InlineButton[][] {
  return [[{ text: '✅ ACK', callbackData: `ack:${alertId}` }], [{ text: '😴 Snooze 1h', callbackData: `snooze:${alertId}` }]];
}
