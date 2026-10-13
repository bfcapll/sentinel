import type { Holding } from '../config/schema.js';
import { proxyWatcher } from './proxy.js';
import type { Watcher } from './types.js';

/**
 * Phase 0 ships only the proxy stub so the whole pipeline (reads, fold, rules, alerts,
 * Telegram, replay) is exercised end to end. Phase 1+ watchers register here.
 */
export const ALL_WATCHERS: readonly Watcher[] = [proxyWatcher];

export function watchersFor(h: Holding, watchers: readonly Watcher[] = ALL_WATCHERS): Watcher[] {
  return watchers.filter((w) => w.appliesTo(h));
}
