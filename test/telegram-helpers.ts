import type { SentinelConfig } from '../src/config/schema.js';
import type { StatusProvider, StatusSnapshot } from '../src/health/status.js';
import { silentLogger } from '../src/log.js';
import { Store } from '../src/store/db.js';
import type { NewAlert } from '../src/store/repos.js';
import { makeFakeGateway } from '../src/telegram/fake.js';
import type { FakeGateway } from '../src/telegram/fake.js';
import { FixedClock } from '../src/time.js';

export const OWNER = 4242;
export const CHATS = { p0: -1001, p1: -1002, p2: -1003 } as const;
export const T0 = 1_760_000_000; // 2025-10-09T08:53:20Z, an arbitrary fixed instant

export const EXPLORER: SentinelConfig['explorer'] = {
  tx_url: 'https://etherscan.io/tx/{hash}',
  block_url: 'https://etherscan.io/block/{number}',
  address_url: 'https://etherscan.io/address/{address}',
};

export function tgConfig(over: Partial<SentinelConfig['telegram']> = {}): SentinelConfig['telegram'] {
  return {
    bots: {
      p0: { token: '111111:AAAA-p0-token-secret', chat_id: CHATS.p0 },
      p1: { token: '222222:BBBB-p1-token-secret', chat_id: CHATS.p1 },
      p2: { token: '333333:CCCC-p2-token-secret', chat_id: CHATS.p2 },
    },
    repeat_minutes: 5,
    repeat_cap_hours: 24,
    global_repeat_min_interval_s: 60,
    snooze_minutes: 60,
    digest: { time: '09:00', timezone: 'UTC' },
    ...over,
  };
}

export function statusSnapshot(over: Partial<StatusSnapshot> = {}): StatusSnapshot {
  return {
    now: T0,
    headBlock: 21_000_000,
    processedBlock: 20_999_998,
    providers: [
      { name: 'alchemy', role: 'primary', head: 21_000_000, lagBlocks: 0, errors1m: 0, active: true },
      { name: 'infura', role: 'secondary', head: 20_999_999, lagBlocks: 1, errors1m: 2, active: false },
      { name: 'drpc', role: 'canary', head: 21_000_000, lagBlocks: 0, errors1m: 0, active: false },
    ],
    lastCycle: { block: 20_999_998, durationMs: 342, at: T0 - 12 },
    uptimeS: 3 * 86_400 + 4 * 3600,
    cyclesLast24h: 7100,
    holdings: [
      { id: 'steakhouse-usdc', exposureUsd: 123_456.78, exitPathOpen: true, exitPathReason: 'maxWithdraw covers position', watchers: ['proxy'] },
      { id: 'ousg', exposureUsd: null, exitPathOpen: false, exitPathReason: 'redemption paused', watchers: ['rwa'] },
    ],
    watchers: [
      { name: 'proxy', consecutiveErrors: 0, lastError: null, lastOkAt: T0 - 5 },
      { name: 'rwa', consecutiveErrors: 3, lastError: 'boom <bad>', lastOkAt: T0 - 600 },
    ],
    lastHealthcheckPingAt: T0 - 45,
    ...over,
  };
}

export class FakeStatus implements StatusProvider {
  constructor(public snap: StatusSnapshot = statusSnapshot()) {}
  snapshot(): StatusSnapshot {
    return { ...this.snap };
  }
}

export interface Env {
  store: Store;
  clock: FixedClock;
  gw: FakeGateway;
  config: SentinelConfig['telegram'];
  status: FakeStatus;
  log: ReturnType<typeof silentLogger>;
}

export function makeEnv(over: Partial<SentinelConfig['telegram']> = {}, t = T0): Env {
  const clock = new FixedClock(t);
  return {
    store: Store.open(':memory:'),
    clock,
    gw: makeFakeGateway(undefined, clock),
    config: tgConfig(over),
    status: new FakeStatus(),
    log: silentLogger(),
  };
}

export function newAlert(over: Partial<NewAlert> = {}): NewAlert {
  return {
    conditionKey: 'steakhouse-usdc/proxy/impl-slot',
    tier: 'P0',
    holding: 'steakhouse-usdc',
    kind: 'open',
    isOps: false,
    exposureUsd: 123_456.78,
    exitPathOpen: true,
    title: 'Implementation slot changed',
    message: '<b>🔴 P0</b> Implementation slot changed\nalert #?',
    block: 21_000_000,
    txHash: null,
    firedAt: T0,
    sendState: 'pending',
    ...over,
  };
}

type SeedAlert = Omit<Partial<NewAlert>, 'sendState'> & { sendState?: NewAlert['sendState'] | 'sent' };

/** Insert an alert; `sendState: 'sent'` simulates one the delivery loop already sent (message id 1). */
export function insertAlert(store: Store, over: SeedAlert = {}): number {
  const { sendState, ...rest } = over;
  const id = store.repos.alert.insert(newAlert({ ...rest, sendState: sendState === 'sent' ? 'pending' : (sendState ?? 'pending') }));
  if (sendState === 'sent') {
    const a = store.repos.alert.get(id);
    store.repos.alert.markSent(id, '0', 1, a?.firedAt ?? T0);
  }
  return id;
}
