import type { Sample } from '../rules/types.js';
import type { HealthEvaluation } from './health.js';

const fmtProviders = (ev: HealthEvaluation): string =>
  ev.providers
    .map((p) => `${p.name}(${p.role}): head ${p.head ?? 'n/a'}, lag ${p.lagBlocks ?? 'n/a'}, silent ${p.stalledForS}s, errors/1m ${p.errors1m}`)
    .join('\n');

/**
 * Turn the RPC health evaluation into OPS conditions (PLAN.md §6.2):
 *  - ops.rpc_lag      P1: providers diverge or one is silent; reads switch to the healthy one
 *  - ops.chain_blind  P0: both providers silent > 5 min, every watcher is blind
 */
export function rpcOpsSamples(ev: HealthEvaluation): Sample[] {
  const canary =
    ev.canaryAdvancing === null ? '' : ev.canaryAdvancing ? '\nPublic canary IS advancing: the problem is on our providers.' : '\nPublic canary is NOT advancing either: the chain itself may be stalled.';
  const base = { holding: 'ops', watcher: 'rpc', persistence: { blocks: 1, cycles: 1 }, resolveCycles: 1, cooldownS: 0 };
  return [
    {
      ...base,
      key: 'ops/rpc/rpc_lag',
      rule: 'ops.rpc_lag',
      tier: ev.rpcLag ? 'P1' : null,
      clear: !ev.rpcLag,
      clearReason: 'RPC providers healthy again',
      context: {
        title: 'RPC provider lag',
        detail: `${ev.reasons.join('; ')}\nActive provider: ${ev.active}\n${fmtProviders(ev)}${canary}`,
        decoded: 'n/a (infrastructure)',
      },
    },
    {
      ...base,
      key: 'ops/rpc/chain_blind',
      rule: 'ops.chain_blind',
      tier: ev.chainBlind ? 'P0' : null,
      clear: !ev.chainBlind,
      clearReason: 'chain reads recovered',
      context: {
        title: 'CHAIN BLIND: both RPC providers are stale',
        detail: `Every watcher is blind until a provider recovers.\n${fmtProviders(ev)}${canary}`,
        decoded: 'n/a (infrastructure)',
      },
    },
  ];
}
