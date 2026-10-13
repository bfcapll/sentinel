/**
 * Read-only view of the running service, consumed by `/status`, the daily digest and the
 * replay summary. The scheduler implements `StatusProvider`; Telegram code only reads it.
 */
export interface StatusSnapshot {
  /** Unix seconds when the snapshot was taken. */
  now: number;
  headBlock: number | null;
  /** Last block fully processed and committed (the cursor). */
  processedBlock: number | null;
  providers: Array<{
    name: string;
    role: 'primary' | 'secondary' | 'canary';
    head: number | null;
    lagBlocks: number | null;
    errors1m: number;
    active: boolean;
  }>;
  lastCycle: { block: number; durationMs: number; at: number } | null;
  uptimeS: number;
  cyclesLast24h: number;
  holdings: Array<{
    id: string;
    exposureUsd: number | null;
    exitPathOpen: boolean;
    exitPathReason: string;
    watchers: string[];
  }>;
  watchers: Array<{ name: string; consecutiveErrors: number; lastError: string | null; lastOkAt: number | null }>;
  lastHealthcheckPingAt: number | null;
}

export interface StatusProvider {
  snapshot(): StatusSnapshot;
}
