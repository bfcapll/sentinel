import type { SentinelConfig } from '../config/schema.js';
import type { Logger } from '../log.js';
import type { Clock } from '../time.js';
import { RpcClient, type ProviderEntry } from './client.js';
import { RpcHealth } from './health.js';
import { HttpTransport } from './http.js';
import { WsHeadSource } from './ws.js';

/** Provider label from the URL host: never includes the key-bearing path. */
export function providerName(url: string, fallback: string): string {
  try {
    const host = new URL(url).hostname;
    if (host.includes('alchemy')) return 'alchemy';
    if (host.includes('infura')) return 'infura';
    if (host.includes('drpc')) return 'drpc';
    return host;
  } catch {
    return fallback;
  }
}

export interface LiveRpc {
  client: RpcClient;
  health: RpcHealth;
  ws: WsHeadSource | null;
  primaryName: string;
}

/** Alchemy (primary) + Infura (secondary) + dRPC canary, per PLAN.md §3.2. */
export function buildLiveRpc(config: SentinelConfig, clock: Clock, log: Logger): LiveRpc {
  const r = config.rpc;
  const mk = (url: string, label: string, batch: boolean): HttpTransport =>
    new HttpTransport({
      url,
      label,
      timeoutMs: r.request_timeout_ms,
      ...(batch ? { batch: { maxSize: 50, waitMs: 5 } } : {}),
    });

  const primaryName = providerName(r.primary.http, 'primary');
  const providers: ProviderEntry[] = [
    { name: primaryName, role: 'primary', transport: mk(r.primary.http, primaryName, true) },
    { name: providerName(r.secondary.http, 'secondary'), role: 'secondary', transport: mk(r.secondary.http, providerName(r.secondary.http, 'secondary'), true) },
    { name: providerName(r.canary.http, 'canary'), role: 'canary', transport: mk(r.canary.http, providerName(r.canary.http, 'canary'), false) },
  ];
  const health = new RpcHealth(
    r.lag,
    providers.map((p) => ({ name: p.name, role: p.role })),
    clock.now(),
  );
  const client = new RpcClient({ providers, health, clock, log, logChunk: config.cycle.max_log_range });
  return { client, health, ws: r.primary.ws ? new WsHeadSource(r.primary.ws, log) : null, primaryName };
}
