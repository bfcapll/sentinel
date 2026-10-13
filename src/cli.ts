#!/usr/bin/env node
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { startService } from './app.js';
import { routeTransitions } from './alerts/router.js';
import { discoverMarkets } from './config/discover.js';
import { ConfigError, loadConfig } from './config/loader.js';
import { generateSchemaMarkdown } from './config/schema-doc.js';
import type { ConfigIssue } from './config/yaml.js';
import { AddressSchema } from './config/schema.js';
import { createLogger } from './log.js';
import { runReplay } from './replay/harness.js';
import { evaluate } from './rules/engine.js';
import type { Sample, Tier } from './rules/types.js';
import { Store } from './store/db.js';
import { createHttpGateway } from './telegram/index.js';

const DEFAULT_CONFIG = process.env['SENTINEL_CONFIG_DIR'] ?? './config';

const HELP = `sentinel: on-chain holdings monitor

  sentinel run [--config DIR]                    start the service
  sentinel config check [--config DIR] [--strict]
  sentinel config discover <holding> [--dry-run] [--config DIR]
  sentinel config schema                         print config/SCHEMA.md to stdout
  sentinel replay --holding ID --from N --to N [--step N]
           [--record NAME] [--fixture NAME] [--timeline FILE]
           [--as-wallet 0x..] [--position-usd N] [--config DIR] [--out DIR]
  sentinel backup [--dest FILE] [--config DIR]   consistent DB backup, prunes old ones
  sentinel status [--config DIR]                 cursor, open conditions, RPC health from the DB
  sentinel healthcheck [--max-age SECONDS]       exit 1 if no cycle committed recently (Docker HEALTHCHECK)
  sentinel telegram test [--config DIR]          send a test message on each bot
  sentinel demo p0|p1|resolve [--config DIR]     inject / close a drill alert in the live DB
`;

function printIssues(issues: ConfigIssue[], stream: NodeJS.WriteStream = process.stderr): void {
  const byFile = new Map<string, ConfigIssue[]>();
  for (const i of issues) byFile.set(i.file, [...(byFile.get(i.file) ?? []), i]);
  for (const [file, list] of byFile) {
    stream.write(`\n${file}\n`);
    for (const i of list) stream.write(`  [${i.kind}] ${i.path}: ${i.message}\n`);
  }
}

async function cmdConfigCheck(dir: string, strict: boolean): Promise<number> {
  try {
    const cfg = loadConfig(dir);
    const verify = cfg.warnings.filter((w) => w.kind === 'verify');
    const other = cfg.warnings.filter((w) => w.kind !== 'verify');
    console.log(`config OK: ${cfg.holdings.length} holding(s): ${cfg.holdings.map((h) => h.id).join(', ') || '(none)'}`);
    if (other.length) printIssues(other, process.stdout);
    if (verify.length) {
      console.log(`\n${verify.length} value(s) still marked "# verify" (check against Etherscan / the issuer repo, then delete the marker):`);
      for (const w of verify) console.log(`  ${w.file}: ${w.path}`);
    }
    return strict && verify.length > 0 ? 1 : 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`CONFIG INVALID: ${e.issues.length} problem(s). The service will not start until these are fixed.`);
      printIssues(e.issues);
      return 1;
    }
    throw e;
  }
}

async function cmdDiscover(dir: string, holding: string, dryRun: boolean): Promise<number> {
  try {
    const r = await discoverMarkets(dir, holding, { dryRun });
    console.log(`${holding}: vault ${r.vault} at block ${r.block}, ${r.markets.length} market(s) in the withdraw queue`);
    for (const m of r.markets) {
      console.log(
        `  ${m.id}  ${m.collateralSymbol}/${m.loanSymbol}  lltv ${(Number(m.lltv) / 1e16).toFixed(1)}%  cap ${m.cap}  ${m.enabled ? 'enabled' : 'DISABLED'}${m.inSupplyQueue ? '' : '  (not in supply queue)'}`,
      );
    }
    if (r.added.length) console.log(`new vs pinned: ${r.added.length}`);
    if (r.removed.length) console.log(`WARNING: previously pinned but no longer in the withdraw queue: ${r.removed.join(', ')}`);
    console.log(r.written ? `pinned ids written to ${r.file}` : 'dry run: nothing written');
    return 0;
  } catch (e) {
    if (e instanceof ConfigError) {
      printIssues(e.issues);
      return 1;
    }
    throw e;
  }
}

async function cmdReplay(values: Record<string, string | boolean | undefined>): Promise<number> {
  const need = (k: string): string => {
    const v = values[k];
    if (typeof v !== 'string') throw new Error(`--${k} is required`);
    return v;
  };
  const asWallet = values['as-wallet'] as string | undefined;
  const report = await runReplay({
    configDir: (values['config'] as string | undefined) ?? DEFAULT_CONFIG,
    holding: need('holding'),
    from: Number(need('from')),
    to: Number(need('to')),
    ...(values['step'] ? { step: Number(values['step']) } : {}),
    ...(values['record'] ? { record: values['record'] as string } : {}),
    ...(values['fixture'] ? { fixture: values['fixture'] as string } : {}),
    ...(asWallet ? { asWallet: AddressSchema.parse(asWallet) } : {}),
    ...(values['position-usd'] ? { positionUsd: Number(values['position-usd']) } : {}),
    ...(values['timeline'] ? { timeline: values['timeline'] as string } : {}),
    outDir: (values['out'] as string | undefined) ?? 'replay-out',
  });
  console.log(`replayed ${report.holding} blocks ${report.from}..${report.to}: ${report.cycles} cycle(s), ${report.alerts.length} alert(s)`);
  for (const a of report.alerts) console.log(`  block ${a.block}  ${a.tier}  ${a.condition_key}  ${a.title}`);
  for (const r of report.resolved) console.log(`  block ${r.block}  RESOLVED  ${r.condition_key}`);
  console.log(`report: ${report.reportFile}\ntelegram sink: ${report.telegramSink}${report.fixtureFile ? `\nfixture: ${report.fixtureFile}` : ''}`);
  if (report.fixtureMisses.length) {
    console.error(`FIXTURE MISSES (${report.fixtureMisses.length}): the pipeline asked for data the fixture does not contain`);
    for (const m of report.fixtureMisses.slice(0, 5)) console.error(`  ${m.slice(0, 200)}`);
    return 1;
  }
  if (report.timeline) {
    if (report.timeline.ok) console.log('timeline: PASS');
    else {
      console.error('timeline: FAIL');
      for (const f of report.timeline.failures) console.error(`  ${f}`);
      return 1;
    }
  }
  return 0;
}

async function cmdBackup(dir: string, dest?: string): Promise<number> {
  const cfg = loadConfig(dir);
  const store = Store.open(cfg.sentinel.store.path);
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = dest ?? path.join(cfg.sentinel.store.backup_dir, `sentinel-${stamp}.db`);
    await store.backupTo(file);
    console.log(`backup written: ${file}`);
    if (!dest) {
      const dirName = cfg.sentinel.store.backup_dir;
      const old = readdirSync(dirName)
        .filter((f) => /^sentinel-.*\.db$/.test(f))
        .sort()
        .slice(0, -cfg.sentinel.store.backup_keep);
      for (const f of old) rmSync(path.join(dirName, f));
      if (old.length) console.log(`pruned ${old.length} old backup(s)`);
    }
    return 0;
  } finally {
    store.close();
  }
}

async function cmdStatus(dir: string): Promise<number> {
  const cfg = loadConfig(dir);
  const store = Store.open(cfg.sentinel.store.path);
  try {
    const cur = store.repos.cursor.get(cfg.sentinel.chain);
    console.log(cur ? `cursor: block ${cur.block} (updated ${new Date(cur.updatedAt * 1000).toISOString()})` : 'cursor: none (service has not completed a cycle)');
    const open = store.repos.condition.listOpen();
    console.log(`open conditions: ${open.length}`);
    for (const c of open) console.log(`  ${c.tier}  ${c.key}  since ${c.openedAt ? new Date(c.openedAt * 1000).toISOString() : '?'}`);
    for (const h of store.repos.rpcHealth.all()) console.log(`rpc ${h.provider}: head ${h.head ?? 'n/a'} lag ${h.lag ?? 'n/a'} errors/1m ${h.errors1m}`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdHealthcheck(dir: string, maxAgeS: number): Promise<number> {
  const cfg = loadConfig(dir);
  const store = Store.open(cfg.sentinel.store.path);
  try {
    const cur = store.repos.cursor.get(cfg.sentinel.chain);
    const age = cur ? Math.floor(Date.now() / 1000) - cur.updatedAt : Number.POSITIVE_INFINITY;
    if (age > maxAgeS) {
      console.error(cur ? `unhealthy: last committed cycle ${age}s ago (limit ${maxAgeS}s)` : 'unhealthy: no cycle has ever committed');
      return 1;
    }
    console.log(`healthy: last committed cycle ${age}s ago`);
    return 0;
  } finally {
    store.close();
  }
}

async function cmdTelegramTest(dir: string): Promise<number> {
  const cfg = loadConfig(dir);
  const gw = createHttpGateway(cfg.sentinel.telegram);
  let bad = 0;
  for (const bot of ['p0', 'p1', 'p2'] as const) {
    try {
      const r = await gw[bot].sendMessage(cfg.sentinel.telegram.bots[bot].chat_id, `Sentinel ${bot.toUpperCase()} bot: test message. If you can read this, delivery works.`);
      console.log(`${bot}: sent (message ${r.messageId})`);
    } catch (e) {
      bad++;
      console.error(`${bot}: FAILED: ${(e as Error).message}`);
    }
  }
  return bad ? 1 : 0;
}

/** Inject a drill alert through the real rules/alert pipeline; the running service delivers it. */
async function cmdDemo(dir: string, what: string): Promise<number> {
  const cfg = loadConfig(dir);
  const store = Store.open(cfg.sentinel.store.path);
  try {
    const key = `drill/${what === 'p1' ? 'p1' : 'p0'}/demo`;
    const tier: Tier = what === 'p1' ? 'P1' : 'P0';
    const now = Math.floor(Date.now() / 1000);
    const cursor = store.repos.cursor.get(cfg.sentinel.chain)?.block ?? 0;
    const sample = (breach: boolean): Sample => ({
      key,
      holding: 'ops',
      watcher: 'drill',
      rule: 'ops.heartbeat',
      tier: breach ? tier : null,
      clear: !breach,
      clearReason: 'drill closed with `sentinel demo resolve`',
      persistence: { blocks: 1, cycles: 1 },
      resolveCycles: 1,
      cooldownS: 0,
      context: {
        title: `DRILL: ${tier} alert (no action needed)`,
        detail: 'Injected by `sentinel demo`. Press ACK to stop the repeats, or run `sentinel demo resolve`.',
        decoded: 'n/a (drill)',
        block: cursor,
      },
    });
    store.tx(() => {
      const prior = store.repos.condition.all();
      const ev = evaluate(prior, [sample(what !== 'resolve')], { block: cursor, ts: now });
      for (const s of ev.states) store.repos.condition.upsert(s);
      const r = routeTransitions({ store, config: cfg, transitions: ev.transitions, positions: new Map(), exitPaths: new Map(), at: { block: cursor, ts: now } });
      console.log(r.created.length ? `drill alert #${r.created[0]!.id} queued (${tier}); the running service will deliver it` : ev.transitions.length ? 'drill resolved' : 'nothing to do (drill already in that state)');
    });
    return 0;
  } finally {
    store.close();
  }
}

async function main(argv: string[]): Promise<number> {
  const [cmd, sub, ...rest] = argv;
  const common = { config: { type: 'string' as const } };
  switch (cmd) {
    case 'run': {
      const { values } = parseArgs({ args: argv.slice(1), options: common, strict: true });
      let svc;
      try {
        svc = startService(values.config ?? DEFAULT_CONFIG);
      } catch (e) {
        if (e instanceof ConfigError) {
          console.error(`CONFIG INVALID: ${e.issues.length} problem(s). Run \`sentinel config check\`.`);
          printIssues(e.issues);
          return 1;
        }
        throw e;
      }
      const stop = async (sig: string): Promise<void> => {
        createLogger().info({ sig }, 'shutting down');
        await svc.stop();
        process.exit(0);
      };
      for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK'] as const) process.on(sig, () => void stop(sig));
      return await new Promise<number>(() => undefined); // run until signalled
    }
    case 'config': {
      if (sub === 'check') {
        const { values } = parseArgs({ args: rest, options: { ...common, strict: { type: 'boolean' } } });
        return cmdConfigCheck(values.config ?? DEFAULT_CONFIG, !!values.strict);
      }
      if (sub === 'discover') {
        const { values, positionals } = parseArgs({ args: rest, options: { ...common, 'dry-run': { type: 'boolean' } }, allowPositionals: true });
        if (!positionals[0]) throw new Error('usage: sentinel config discover <holding>');
        return cmdDiscover(values.config ?? DEFAULT_CONFIG, positionals[0], !!values['dry-run']);
      }
      if (sub === 'schema') {
        process.stdout.write(generateSchemaMarkdown() + '\n');
        return 0;
      }
      break;
    }
    case 'replay': {
      const { values } = parseArgs({
        args: argv.slice(1),
        options: {
          ...common,
          holding: { type: 'string' },
          from: { type: 'string' },
          to: { type: 'string' },
          step: { type: 'string' },
          record: { type: 'string' },
          fixture: { type: 'string' },
          timeline: { type: 'string' },
          'as-wallet': { type: 'string' },
          'position-usd': { type: 'string' },
          out: { type: 'string' },
        },
      });
      return cmdReplay(values);
    }
    case 'backup': {
      const { values } = parseArgs({ args: argv.slice(1), options: { ...common, dest: { type: 'string' } } });
      return cmdBackup(values.config ?? DEFAULT_CONFIG, values.dest);
    }
    case 'status': {
      const { values } = parseArgs({ args: argv.slice(1), options: common });
      return cmdStatus(values.config ?? DEFAULT_CONFIG);
    }
    case 'healthcheck': {
      const { values } = parseArgs({ args: argv.slice(1), options: { ...common, 'max-age': { type: 'string' } } });
      return cmdHealthcheck(values.config ?? DEFAULT_CONFIG, Number(values['max-age'] ?? 300));
    }
    case 'telegram': {
      if (sub === 'test') {
        const { values } = parseArgs({ args: rest, options: common });
        return cmdTelegramTest(values.config ?? DEFAULT_CONFIG);
      }
      break;
    }
    case 'demo': {
      const { values } = parseArgs({ args: rest, options: common });
      if (sub === 'p0' || sub === 'p1' || sub === 'resolve') return cmdDemo(values.config ?? DEFAULT_CONFIG, sub);
      break;
    }
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      return 0;
  }
  console.error(`unknown command\n\n${HELP}`);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code !== 0) process.exitCode = code;
  },
  (e: unknown) => {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  },
);

