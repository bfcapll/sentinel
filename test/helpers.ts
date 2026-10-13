import path from 'node:path';
import { loadConfig, type LoadedConfig } from '../src/config/loader.js';
import { silentLogger } from '../src/log.js';
import { RpcClient } from '../src/rpc/client.js';
import { RpcHealth } from '../src/rpc/health.js';
import type { RpcTransport } from '../src/rpc/types.js';
import { DEMO, proxyUpgradeScenario } from '../src/replay/scenarios.js';
import { SyntheticChain, type SyntheticScenario } from '../src/replay/synthetic.js';
import { Scheduler, type SchedulerOptions } from '../src/scheduler.js';
import { Store } from '../src/store/db.js';
import { FixedClock } from '../src/time.js';

export const DEMO_CONFIG_DIR = path.resolve('fixtures/demo/config');

export const demoConfig = (): LoadedConfig => loadConfig(DEMO_CONFIG_DIR, { skipDotEnv: true, env: {} });

export function makeClient(transport: RpcTransport, clock = new FixedClock(1_700_000_000)): RpcClient {
  const health = new RpcHealth({ max_block_diff: 5, diff_secs: 60, stall_secs: 90, blind_secs: 300 }, [{ name: 'primary', role: 'primary' }], clock.now());
  return new RpcClient({ providers: [{ name: 'primary', role: 'primary', transport }], health, clock, log: silentLogger() });
}

export interface Harness {
  scheduler: Scheduler;
  store: Store;
  chain: SyntheticChain;
  clock: FixedClock;
  config: LoadedConfig;
}

export function makeScheduler(opts: { scenario?: SyntheticScenario; scheduler?: Partial<SchedulerOptions> } = {}): Harness {
  const config = demoConfig();
  const store = Store.open(':memory:');
  const chain = new SyntheticChain(opts.scenario ?? proxyUpgradeScenario());
  const clock = new FixedClock(1_700_000_000);
  const scheduler = new Scheduler({
    config,
    store,
    reader: makeClient(chain, clock),
    log: silentLogger(),
    clock,
    useBlockTime: true,
    holdingFilter: [DEMO.holding],
    ...opts.scheduler,
  });
  return { scheduler, store, chain, clock, config };
}
