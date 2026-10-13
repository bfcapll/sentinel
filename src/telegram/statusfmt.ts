/** Formatting of StatusSnapshot pieces shared by `/status` and the daily digest. */
import { formatUsd } from '../alerts/render.js';
import type { StatusSnapshot } from '../health/status.js';
import { escapeHtml, formatAge, fitEscaped } from './util.js';

/** Lag above this many blocks is called out as a problem (mirrors the rpc.lag.max_block_diff default). */
const LAG_WARN_BLOCKS = 5;

const n = (v: number | null): string => (v === null ? 'n/a' : v.toLocaleString('en-US'));

export function rpcSummary(s: StatusSnapshot): string {
  const live = s.providers.filter((p) => p.role !== 'canary');
  if (live.length === 0) return 'rpc unknown';
  const lags = live.map((p) => p.lagBlocks).filter((l): l is number => l !== null);
  const stale = live.some((p) => p.head === null);
  const worst = lags.length ? Math.max(...lags) : 0;
  if (stale) return 'rpc DEGRADED (provider has no head)';
  return worst > LAG_WARN_BLOCKS ? `rpc LAG ${worst} blocks` : 'rpc OK';
}

export function lastPingText(s: StatusSnapshot): string {
  return s.lastHealthcheckPingAt === null ? 'never' : `${formatAge(s.now - s.lastHealthcheckPingAt)} ago`;
}

export function watcherErrorCount(s: StatusSnapshot): number {
  return s.watchers.filter((w) => w.consecutiveErrors > 0).length;
}

export function aliveLine(s: StatusSnapshot): string {
  return (
    `✅ <b>Sentinel alive</b> — head ${n(s.headBlock)}, processed ${n(s.processedBlock)}, uptime ${formatAge(s.uptimeS)}, ` +
    `${s.cyclesLast24h} cycles/24h, ${rpcSummary(s)}, last Healthchecks ping ${lastPingText(s)}, watcher errors ${watcherErrorCount(s)}`
  );
}

export function providerLines(s: StatusSnapshot): string[] {
  if (s.providers.length === 0) return ['• no providers reported'];
  return s.providers.map(
    (p) =>
      `• <b>${escapeHtml(p.name)}</b> (${p.role}${p.active ? ', ACTIVE' : ''}): head ${n(p.head)}, lag ${p.lagBlocks === null ? 'n/a' : p.lagBlocks}, errors/1m ${p.errors1m}`,
  );
}

export function exposureLine(h: StatusSnapshot['holdings'][number]): string {
  const exit = h.exitPathOpen ? 'OPEN' : 'CLOSED';
  return `<code>${escapeHtml(h.id)}</code>: ${formatUsd(h.exposureUsd)} — exit path ${exit} (${escapeHtml(fitEscaped(h.exitPathReason, 160))})`;
}

export function watcherLines(s: StatusSnapshot): string[] {
  const bad = s.watchers.filter((w) => w.consecutiveErrors > 0);
  if (bad.length === 0) return [`• all ${s.watchers.length} watchers healthy (0 consecutive errors)`];
  return bad.map(
    (w) =>
      `• <b>${escapeHtml(w.name)}</b>: ${w.consecutiveErrors} consecutive errors` +
      (w.lastError ? ` — ${escapeHtml(fitEscaped(w.lastError, 160))}` : ''),
  );
}
