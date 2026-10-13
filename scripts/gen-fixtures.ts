/**
 * Regenerate fixtures/proxy-upgrade.json by recording a replay against the in-process synthetic
 * chain, through the real `--record` path. Run: npm run gen:fixtures
 */
import { DEMO, proxyUpgradeScenario } from '../src/replay/scenarios.js';
import { runReplay } from '../src/replay/harness.js';
import { SyntheticChain } from '../src/replay/synthetic.js';

const report = await runReplay({
  configDir: 'fixtures/demo/config',
  holding: DEMO.holding,
  from: DEMO.from,
  to: DEMO.to,
  record: 'proxy-upgrade',
  timeline: 'fixtures/proxy-upgrade.timeline.json',
  outDir: 'replay-out',
  transports: [{ name: 'primary', role: 'primary', transport: new SyntheticChain(proxyUpgradeScenario()) }],
});
console.log(`recorded ${report.fixtureFile}: ${report.alerts.length} alert(s); timeline ${report.timeline?.ok ? 'PASS' : 'FAIL'}`);
if (!report.timeline?.ok) process.exit(1);
