import type { LoadedConfig } from '../config/loader.js';
import type { PositionSummary, ExitPath } from '../position/index.js';
import { TIER_RANK, type EvalPoint, type Tier, type Transition } from '../rules/types.js';
import type { Store } from '../store/db.js';
import { renderAlert } from './render.js';

export interface RouteArgs {
  store: Store;
  config: LoadedConfig;
  transitions: Transition[];
  positions: Map<string, PositionSummary>;
  exitPaths: Map<string, ExitPath>;
  at: EvalPoint;
}

export interface RouteResult {
  created: Array<{ id: number; tier: Tier; key: string }>;
  resolvedKeys: string[];
}

const OPS_HOLDING = 'ops';

/**
 * Final tier after the deterministic escalation rule (PLAN.md §6.1): a P1 on a holding whose exit
 * path is CLOSED at fire time is promoted to P0. OPS alerts keep their own tier.
 */
export function finalTier(base: Tier, isOps: boolean, exit: ExitPath | undefined): { tier: Tier; promoted: boolean } {
  if (!isOps && base === 'P1' && exit && !exit.open) return { tier: 'P0', promoted: true };
  return { tier: base, promoted: false };
}

/**
 * Turn rule transitions into `alert` rows (rendered, queued for delivery) and resolve closed
 * conditions. Runs inside the cycle's SQLite transaction: delivery to Telegram is a separate
 * outbox step, so a crash between commit and send loses nothing.
 */
export function routeTransitions(a: RouteArgs): RouteResult {
  const { store, config } = a;
  const repo = store.repos.alert;
  const result: RouteResult = { created: [], resolvedKeys: [] };

  for (const t of a.transitions) {
    if (t.type === 'still_open') continue;

    if (t.type === 'resolved') {
      repo.resolveKey(t.key, a.at.ts, t.reason);
      result.resolvedKeys.push(t.key);
      continue;
    }

    const s = t.sample;
    const isOps = s.holding === OPS_HOLDING;
    const exit = isOps ? undefined : a.exitPaths.get(s.holding);
    const { tier, promoted } = finalTier(t.tier, isOps, exit);
    const position = isOps ? undefined : a.positions.get(s.holding);
    const context = promoted
      ? { ...s.context, detail: `${s.context.detail ? s.context.detail + '\n' : ''}Promoted from P1: exit path is CLOSED.` }
      : s.context;

    // An escalation never downgrades: if the promotion rule already put us above the new tier, keep it.
    const prior = repo.openForKey(t.key);
    const priorTop = prior.reduce<Tier | null>((m, p) => (m === null || TIER_RANK[p.tier] > TIER_RANK[m] ? p.tier : m), null);
    if (t.type === 'escalated' && priorTop !== null && TIER_RANK[priorTop] >= TIER_RANK[tier]) continue;

    const id = repo.insert({
      conditionKey: t.key,
      tier,
      holding: s.holding,
      kind: t.type === 'escalated' ? 'escalation' : 'open',
      isOps,
      exposureUsd: position?.exposureUsd ?? null,
      exitPathOpen: exit ? exit.open : null,
      title: context.title,
      message: '',
      block: a.at.block,
      txHash: context.txHash ?? null,
      firedAt: a.at.ts,
      sendState: tier === 'P2' ? 'digest' : 'pending',
    });
    repo.setMessage(
      id,
      renderAlert({
        tier,
        isOps,
        holding: s.holding,
        conditionKey: t.key,
        alertId: id,
        kind: t.type === 'escalated' ? 'escalation' : 'open',
        exposureUsd: position?.exposureUsd ?? null,
        ...(position?.note ? { exposureNote: position.note } : {}),
        exitPathOpen: exit ? exit.open : null,
        exitPathReason: exit ? exit.reason : 'infrastructure alert (not holding-specific)',
        context,
        explorer: config.sentinel.explorer,
        timezone: config.sentinel.telegram.digest.timezone,
      }),
    );
    for (const p of prior) repo.markSuperseded(p.id, id);
    result.created.push({ id, tier, key: t.key });
  }
  return result;
}
