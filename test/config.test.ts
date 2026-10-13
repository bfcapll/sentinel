import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverMarkets } from '../src/config/discover.js';
import { ConfigError, loadConfig } from '../src/config/loader.js';
import { generateSchemaMarkdown } from '../src/config/schema-doc.js';
import type { ChainReader, ReadCall, ReadResult } from '../src/rpc/types.js';

const SENTINEL = `
rpc:
  primary: { http: "https://rpc.invalid/\${KEY}", ws: "wss://rpc.invalid/\${KEY}" }
  secondary: { http: "https://rpc2.invalid/x" }
  canary: { http: "https://rpc3.invalid/x" }
telegram:
  bots:
    p0: { token: "0000000001:aaaaaaaaaa", chat_id: "-1" }
    p1: { token: "0000000002:aaaaaaaaaa", chat_id: "-2" }
    p2: { token: "0000000003:aaaaaaaaaa", chat_id: "-3" }
healthchecks: { ping_url: "https://hc.invalid/x" }
etherscan: { api_key: e }
safe_tx_service: { api_key: s }
`;
const WALLETS = `telegram_user_id: 42\nwallets:\n  - { label: main, address: "0x2222222222222222222222222222222222222222" }\n`;
const HOLDING = (extra = '') => `
id: h1
kind: metamorpho
asset: { address: 0x1111111111111111111111111111111111111111, decimals: 18, symbol: v, loan_token: { address: 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48, symbol: USDC, decimals: 6 } }
wallets: [main]
exposure: { price_feed: "const:1.0" }
control_graph:
  - id: vault
    type: metamorpho
    address: 0x1111111111111111111111111111111111111111
    expect:
      owner: 0x3333333333333333333333333333333333333333
      curator: 0x4444444444444444444444444444444444444444
      guardian: 0x5555555555555555555555555555555555555555
      timelock_s: 604800
  - id: owner-safe
    type: safe
    address: <vault.expect.owner>
    expect: { threshold_min: 2 }
  - id: morpho
    $ref: shared/morpho
    expect: { owner: 0x6666666666666666666666666666666666666666 }
${extra}`;

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'sentinel-cfg-'));
  for (const [f, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    writeFileSync(path.join(dir, f), content);
  }
  return dir;
}
const base = (over: Record<string, string> = {}): Record<string, string> => ({
  'sentinel.yaml': SENTINEL,
  'wallets.yaml': WALLETS,
  'shared/morpho.yaml': 'type: morpho-blue\naddress: 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb # verify\nexpect: {}\n',
  'holdings/h1.yaml': HOLDING(),
  ...over,
});
const load = (dir: string, env: Record<string, string> = { KEY: 'k' }) => loadConfig(dir, { env, skipDotEnv: true });
const issuesOf = (dir: string, env?: Record<string, string>) => {
  try {
    load(dir, env);
  } catch (e) {
    if (e instanceof ConfigError) return e.issues;
    throw e;
  }
  return [];
};

describe('config loader', () => {
  it('loads a valid project: env substitution, $ref merge, node references, hex addresses as strings', () => {
    const cfg = load(project(base()));
    expect(cfg.sentinel.rpc.primary.http).toBe('https://rpc.invalid/k');
    const h = cfg.holdings[0]!;
    const safe = h.control_graph.find((n) => n.id === 'owner-safe')!;
    expect(safe.address).toBe('0x3333333333333333333333333333333333333333');
    const morpho = h.control_graph.find((n) => n.id === 'morpho')!;
    expect(morpho.address).toBe('0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb');
    expect((morpho as { expect: { owner?: string } }).expect.owner).toBe('0x6666666666666666666666666666666666666666');
    // zod defaults
    expect(cfg.sentinel.rpc.confirmations).toBe(2);
    expect(cfg.holdings[0]!.exposure.exit_size).toBe('100%');
  });

  it('reports # verify markers as warnings, not errors', () => {
    const cfg = load(project(base()));
    expect(cfg.warnings.filter((w) => w.kind === 'verify').map((w) => w.path)).toContain('address');
  });

  it('missing env vars fail loudly by name and never echo values', () => {
    const issues = issuesOf(project(base()), {});
    expect(issues.some((i) => i.kind === 'env' && i.message.includes('KEY'))).toBe(true);
    expect(JSON.stringify(issues)).not.toContain('secret');
  });

  it('empty env vars count as missing', () => {
    expect(issuesOf(project(base()), { KEY: '' }).some((i) => i.kind === 'env')).toBe(true);
  });

  it('unfilled placeholders fail with their path', () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING().replace('0x3333333333333333333333333333333333333333', '0x…') }));
    const issues = issuesOf(dir);
    expect(issues).toContainEqual(expect.objectContaining({ kind: 'placeholder', path: 'control_graph[0].expect.owner' }));
  });

  it('unresolved <references> are reported', () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING('  - id: x\n    type: safe\n    address: <nope>\n') }));
    expect(issuesOf(dir).some((i) => i.kind === 'placeholder' && i.message.includes('<nope>'))).toBe(true);
  });

  it('unknown keys and bad checksums are schema errors', () => {
    expect(issuesOf(project(base({ 'holdings/h1.yaml': HOLDING() + 'typo_key: 1\n' }))).some((i) => i.kind === 'schema')).toBe(true);
    const bad = HOLDING().replace('0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', '0xa0B86991c6218b36c1d19D4a2e9Eb0cE3606eB48');
    expect(issuesOf(project(base({ 'holdings/h1.yaml': bad }))).some((i) => /checksum/.test(i.message))).toBe(true);
  });

  it('unknown threshold keys are rejected', () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING() + 'thresholds:\n  not.a.key: { p0: 1 }\n' }));
    expect(issuesOf(dir).some((i) => /unknown threshold key/.test(i.message))).toBe(true);
  });

  it('cross-checks wallet labels, node references and unknown $refs', () => {
    expect(issuesOf(project(base({ 'holdings/h1.yaml': HOLDING().replace('[main]', '[ghost]') }))).some((i) => /ghost/.test(i.message))).toBe(true);
    expect(issuesOf(project(base({ 'holdings/h1.yaml': HOLDING('pending_actions:\n  - { source: timelock, node: nope }\n') }))).some((i) => /unknown control_graph node/.test(i.message))).toBe(true);
    expect(issuesOf(project(base({ 'holdings/h1.yaml': HOLDING('  - id: y\n    $ref: shared/missing\n') }))).some((i) => i.kind === 'ref')).toBe(true);
  });

  it('missing wallets.yaml explains how to create it', () => {
    const files = base();
    delete (files as Record<string, string | undefined>)['wallets.yaml'];
    expect(issuesOf(project(files)).some((i) => /wallets\.example\.yaml/.test(i.message))).toBe(true);
  });

  it('threshold() layers defaults < sentinel.yaml < holding', () => {
    const dir = project(
      base({
        'sentinel.yaml': SENTINEL + 'thresholds:\n  peg.exit_cost: { p1: 40 }\n',
        'holdings/h1.yaml': HOLDING() + 'thresholds:\n  peg.exit_cost: { p0: 150 }\n',
      }),
    );
    const cfg = load(dir);
    expect(cfg.threshold(cfg.holdings[0], 'peg.exit_cost')).toMatchObject({ p0: 150, p1: 40, p2: 20 });
    expect(cfg.threshold(undefined, 'peg.exit_cost')).toMatchObject({ p0: 200, p1: 40 });
  });

  it('the shipped example holding fails the check until its placeholders are filled', () => {
    expect(() => loadConfig('config', { env: {}, skipDotEnv: true })).toThrow(ConfigError);
    try {
      loadConfig('config', { env: {}, skipDotEnv: true });
    } catch (e) {
      const issues = (e as ConfigError).issues;
      expect(issues.some((i) => i.file.endsWith('steakhouse-usdc.yaml') && i.kind === 'placeholder')).toBe(true);
      expect(issues.some((i) => i.kind === 'env')).toBe(true);
    }
  });

  it('config/SCHEMA.md is up to date with the zod schema', () => {
    expect(readFileSync('config/SCHEMA.md', 'utf8')).toBe(generateSchemaMarkdown() + '\n');
  });
});

describe('config discover', () => {
  const VAULT = '0x1111111111111111111111111111111111111111';
  const ID_A = `0x${'a'.repeat(64)}`;
  const ID_B = `0x${'b'.repeat(64)}`;
  const COLL = '0x7777777777777777777777777777777777777777';
  const LOAN = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  /** Fake chain: answers the exact reads discovery makes. */
  const reader: ChainReader = {
    getBlock: async () => { throw new Error('unused'); },
    getBlockNumber: async () => 1,
    getStorageAt: async () => '0x',
    getLogs: async () => [],
    multicall: async (calls: ReadCall[]): Promise<ReadResult[]> =>
      calls.map((c): ReadResult => {
        switch (c.functionName) {
          case 'withdrawQueueLength': return { ok: true, value: 2n };
          case 'supplyQueueLength': return { ok: true, value: 1n };
          case 'withdrawQueue': return { ok: true, value: c.args![0] === 0n ? ID_A : ID_B };
          case 'supplyQueue': return { ok: true, value: ID_A };
          case 'idToMarketParams': return { ok: true, value: [LOAN, COLL, '0x8888888888888888888888888888888888888888', '0x9999999999999999999999999999999999999999', 860000000000000000n] };
          case 'config': return { ok: true, value: [1000n, true, 0n] };
          case 'symbol': return { ok: true, value: c.address === COLL ? 'WBTC' : 'USDC' };
          default: return { ok: false, error: 'unexpected' };
        }
      }),
  };

  it('pins withdrawQueue ids into the holding file, keeping comments and unrelated text', async () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING() + 'markets:\n  allowlist_mode: pin\n  pinned: []\n# trailing comment\n' }));
    const r = await discoverMarkets(dir, 'h1', { reader, block: 1, env: { KEY: 'k' }, skipDotEnv: true });
    expect(r.markets.map((m) => m.id)).toEqual([ID_A, ID_B]);
    expect(r.written).toBe(true);
    const text = readFileSync(path.join(dir, 'holdings/h1.yaml'), 'utf8');
    expect(text).toContain(ID_A);
    expect(text).toContain('WBTC/USDC lltv 86.0%');
    expect(text).toContain('# trailing comment');
    expect(text).toContain('$ref: shared/morpho');
    // the rewritten file still validates and now carries the pins
    expect(load(dir).holdings[0]!.markets?.pinned).toEqual([ID_A, ID_B]);
  });

  it('dry run writes nothing and reports additions/removals', async () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING() + `markets:\n  pinned: ["0x${'c'.repeat(64)}"]\n` }));
    const before = readFileSync(path.join(dir, 'holdings/h1.yaml'), 'utf8');
    const r = await discoverMarkets(dir, 'h1', { reader, block: 1, dryRun: true, env: { KEY: 'k' }, skipDotEnv: true });
    expect(r.written).toBe(false);
    expect(r.removed).toEqual([`0x${'c'.repeat(64)}`]);
    expect(r.added).toHaveLength(2);
    expect(readFileSync(path.join(dir, 'holdings/h1.yaml'), 'utf8')).toBe(before);
  });

  it('refuses when the vault address is still a placeholder', async () => {
    const dir = project(base({ 'holdings/h1.yaml': HOLDING().replace('address: 0x1111111111111111111111111111111111111111\n    expect', 'address: 0x…\n    expect') }));
    await expect(discoverMarkets(dir, 'h1', { reader, block: 1, env: { KEY: 'k' }, skipDotEnv: true })).rejects.toBeInstanceOf(ConfigError);
    void VAULT;
  });
});
