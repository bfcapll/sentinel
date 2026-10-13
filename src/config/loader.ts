import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import type { ZodType } from 'zod';
import { resolveThreshold, type ThresholdKey, type ThresholdSpec } from '../rules/defaults.js';
import {
  ChainlinkFeedsSchema,
  HoldingSchema,
  PoolRegistrySchema,
  SHARED_REGISTRIES,
  SentinelSchema,
  SharedNodeSchema,
  TokensSchema,
  WalletsSchema,
  type ChainlinkFeeds,
  type Holding,
  type SentinelConfig,
  type Tokens,
  type WalletsConfig,
} from './schema.js';
import {
  deepMerge,
  formatPath,
  isObject,
  isPlaceholder,
  mapStrings,
  readYaml,
  substituteEnv,
  verifyMarks,
  type ConfigIssue,
  type Json,
  type RawYaml,
} from './yaml.js';

export class ConfigError extends Error {
  constructor(public readonly issues: ConfigIssue[]) {
    super(`config invalid: ${issues.length} problem(s)`);
    this.name = 'ConfigError';
  }
}

export interface LoadedConfig {
  dir: string;
  sentinel: SentinelConfig;
  wallets: WalletsConfig;
  holdings: Holding[];
  registries: {
    chainlinkFeeds: ChainlinkFeeds;
    tokens: Tokens;
    curvePools: Record<string, { address: string }>;
    uniswapV3Pools: Record<string, { address: string }>;
  };
  /** `# verify` markers and other non-fatal notes. */
  warnings: ConfigIssue[];
  /** Effective threshold spec: defaults < sentinel.yaml < holding. Pass holding=undefined for global. */
  threshold(holding: Holding | undefined, key: ThresholdKey): ThresholdSpec;
}

export interface LoadOptions {
  env?: NodeJS.ProcessEnv;
  /** Skip loading `.env` from the config dir's parent. */
  skipDotEnv?: boolean;
  /** Where to find `.env`; defaults to cwd. */
  envFile?: string;
}

/** Load `.env` into a copy of the environment. Existing process env wins over the file. */
export function loadEnv(opts: LoadOptions = {}): NodeJS.ProcessEnv {
  const base = { ...(opts.env ?? process.env) };
  if (opts.skipDotEnv) return base;
  const file = opts.envFile ?? path.resolve('.env');
  if (existsSync(file)) {
    const parsed = parseEnv(readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (base[k] === undefined || base[k] === '') base[k] = v;
  }
  return base;
}

interface RawProject {
  dir: string;
  issues: ConfigIssue[];
  sentinel?: RawYaml;
  wallets?: RawYaml;
  shared: Map<string, RawYaml>;
  holdings: Map<string, RawYaml>;
}

function listYaml(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') || f.endsWith('.yml'))
    .filter((f) => !f.includes('.example.'))
    .sort()
    .map((f) => path.join(dir, f));
}

const nameOf = (file: string): string => path.basename(file).replace(/\.ya?ml$/, '');

function tryRead(file: string, issues: ConfigIssue[], required: boolean, hint?: string): RawYaml | undefined {
  if (!existsSync(file)) {
    if (required) issues.push({ file, path: '(file)', kind: 'io', message: `missing file${hint ? `: ${hint}` : ''}` });
    return undefined;
  }
  try {
    return readYaml(file);
  } catch (e) {
    issues.push({ file, path: '(file)', kind: 'io', message: (e as Error).message });
    return undefined;
  }
}

function readProject(dir: string): RawProject {
  const issues: ConfigIssue[] = [];
  const shared = new Map<string, RawYaml>();
  const holdings = new Map<string, RawYaml>();
  const sentinel = tryRead(path.join(dir, 'sentinel.yaml'), issues, true);
  const wallets = tryRead(
    path.join(dir, 'wallets.yaml'),
    issues,
    true,
    'copy config/wallets.example.yaml to config/wallets.yaml and fill in your EOAs and Telegram user id',
  );
  for (const f of listYaml(path.join(dir, 'shared'))) {
    const r = tryRead(f, issues, true);
    if (r) shared.set(nameOf(f), r);
  }
  for (const f of listYaml(path.join(dir, 'holdings'))) {
    const r = tryRead(f, issues, true);
    if (r) holdings.set(nameOf(f), r);
  }
  return { dir, issues, sentinel, wallets, shared, holdings };
}

/** Apply env substitution to every string leaf. */
function substitute(raw: RawYaml, env: NodeJS.ProcessEnv, issues: ConfigIssue[]): Json {
  return mapStrings(raw.data, (s, p) => {
    const missing: string[] = [];
    const out = substituteEnv(s, env, missing);
    for (const name of missing) {
      issues.push({
        file: raw.file,
        path: formatPath(p),
        kind: 'env',
        message: `environment variable ${name} is not set (add it to .env, see .env.example)`,
      });
    }
    return out;
  });
}

/** Replace `{ $ref: shared/<name>, ...overrides }` objects with the merged shared content. */
function resolveRefs(
  value: Json,
  file: string,
  shared: Map<string, Json>,
  issues: ConfigIssue[],
  p: Array<string | number> = [],
  depth = 0,
): Json {
  if (Array.isArray(value)) return value.map((x, i) => resolveRefs(x, file, shared, issues, [...p, i], depth));
  if (!isObject(value)) return value;
  if (typeof value['$ref'] === 'string') {
    const ref = value['$ref'];
    const name = ref.replace(/^shared\//, '');
    const target = shared.get(name);
    const { $ref: _drop, ...overrides } = value;
    if (!target) {
      issues.push({
        file,
        path: formatPath(p),
        kind: 'ref',
        message: `$ref "${ref}" does not match any file in config/shared/ (known: ${[...shared.keys()].join(', ')})`,
      });
      return overrides;
    }
    if (depth > 5) {
      issues.push({ file, path: formatPath(p), kind: 'ref', message: `$ref nesting too deep at "${ref}"` });
      return overrides;
    }
    const resolvedTarget = resolveRefs(target, file, shared, issues, p, depth + 1);
    return deepMerge(resolvedTarget, resolveRefs(overrides, file, shared, issues, p, depth));
  }
  const out: { [k: string]: Json } = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, file, shared, issues, [...p, k], depth);
  return out;
}

const NODE_REF_RE = /^<([a-z0-9-]+)((?:\.[A-Za-z0-9_]+)*)>$/;

/** Resolve `<node-id>` and `<node-id.expect.field>` references inside a holding. */
function resolveNodeRefs(doc: Json, file: string, issues: ConfigIssue[]): Json {
  if (!isObject(doc)) return doc;
  const graph = Array.isArray(doc['control_graph']) ? doc['control_graph'] : [];
  const nodes = new Map<string, Json>();
  for (const n of graph) if (isObject(n) && typeof n['id'] === 'string') nodes.set(n['id'], n);

  const lookup = (id: string, rest: string): Json | undefined => {
    const node = nodes.get(id);
    if (node === undefined) return undefined;
    if (!rest) return isObject(node) ? node['address'] : undefined;
    let cur: Json | undefined = node;
    for (const seg of rest.slice(1).split('.')) {
      if (!isObject(cur)) return undefined;
      cur = cur[seg];
    }
    return cur;
  };

  let current: Json = doc;
  for (let pass = 0; pass < 4; pass++) {
    let changed = false;
    current = mapStrings(current, (s) => {
      const m = NODE_REF_RE.exec(s.trim());
      if (!m) return s;
      const v = lookup(m[1] as string, m[2] ?? '');
      if (typeof v === 'string' && !NODE_REF_RE.test(v)) {
        changed = true;
        return v;
      }
      return s;
    });
    if (!changed) break;
  }
  void file;
  void issues;
  return current;
}

/** Report every unfilled placeholder / unresolved reference. */
function scanPlaceholders(doc: Json, file: string, issues: ConfigIssue[]): number {
  let n = 0;
  mapStrings(doc, (s, p) => {
    if (isPlaceholder(s)) {
      n++;
      issues.push({
        file,
        path: formatPath(p),
        kind: 'placeholder',
        message: NODE_REF_RE.test(s.trim())
          ? `unresolved reference ${s} (no control_graph node with that id)`
          : `unfilled placeholder "${s}" — fill in the real value`,
      });
    }
    return s;
  });
  return n;
}

function zodIssues<T>(schema: ZodType<T>, data: unknown, file: string, issues: ConfigIssue[]): T | undefined {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  for (const i of r.error.issues) {
    issues.push({ file, path: formatPath(i.path as Array<string | number>), kind: 'schema', message: i.message });
  }
  return undefined;
}

/** Loads and fully validates the config directory. Throws ConfigError listing every problem. */
export function loadConfig(dir: string, opts: LoadOptions = {}): LoadedConfig {
  const env = loadEnv(opts);
  const project = readProject(dir);
  const issues = project.issues;
  const warnings: ConfigIssue[] = [];

  /* ---- shared */
  const sharedResolved = new Map<string, Json>();
  const sharedBroken = new Set<string>();
  for (const [name, raw] of project.shared) {
    const before = issues.length;
    sharedResolved.set(name, substitute(raw, env, issues));
    if (issues.length > before) sharedBroken.add(name);
  }

  const registries: Partial<Record<keyof typeof SHARED_REGISTRIES, unknown>> = {};
  for (const [name, raw] of project.shared) {
    const data = sharedResolved.get(name) as Json;
    for (const p of verifyMarks(raw.doc)) {
      warnings.push({ file: raw.file, path: p, kind: 'verify', message: 'marked # verify (not yet checked against Etherscan / issuer repo)' });
    }
    const placeholders = scanPlaceholders(data, raw.file, issues);
    if (placeholders > 0 || sharedBroken.has(name)) continue;
    if (name in SHARED_REGISTRIES) {
      const schema = SHARED_REGISTRIES[name as keyof typeof SHARED_REGISTRIES] as ZodType;
      registries[name as keyof typeof SHARED_REGISTRIES] = zodIssues(schema, data, raw.file, issues);
    } else {
      zodIssues(SharedNodeSchema, { ...(data as object) }, raw.file, issues);
    }
  }

  /* ---- sentinel.yaml */
  let sentinel: SentinelConfig | undefined;
  if (project.sentinel) {
    const before = issues.length;
    const data = substitute(project.sentinel, env, issues);
    const envOk = issues.length === before;
    for (const p of verifyMarks(project.sentinel.doc)) {
      warnings.push({ file: project.sentinel.file, path: p, kind: 'verify', message: 'marked # verify' });
    }
    if (scanPlaceholders(data, project.sentinel.file, issues) === 0 && envOk) {
      sentinel = zodIssues(SentinelSchema, data, project.sentinel.file, issues);
    }
  }

  /* ---- wallets.yaml */
  let wallets: WalletsConfig | undefined;
  if (project.wallets) {
    const before = issues.length;
    const data = substitute(project.wallets, env, issues);
    if (scanPlaceholders(data, project.wallets.file, issues) === 0 && issues.length === before) {
      wallets = zodIssues(WalletsSchema, data, project.wallets.file, issues);
    }
  }

  /* ---- holdings */
  const holdings: Holding[] = [];
  for (const [name, raw] of project.holdings) {
    const before = issues.length;
    const substituted = substitute(raw, env, issues);
    const envOk = issues.length === before;
    const withRefs = resolveRefs(substituted, raw.file, sharedResolved, issues);
    const resolved = resolveNodeRefs(withRefs, raw.file, issues);
    for (const p of verifyMarks(raw.doc)) {
      warnings.push({ file: raw.file, path: p, kind: 'verify', message: 'marked # verify (not yet checked against Etherscan / issuer repo)' });
    }
    if (scanPlaceholders(resolved, raw.file, issues) > 0 || !envOk) continue;
    const h = zodIssues(HoldingSchema, resolved, raw.file, issues);
    if (!h) continue;
    if (h.id !== name) {
      warnings.push({ file: raw.file, path: 'id', kind: 'cross', message: `file name "${name}" differs from id "${h.id}"` });
    }
    holdings.push(h);
  }

  /* ---- cross checks */
  if (wallets) {
    const labels = new Set(wallets.wallets.map((w) => w.label));
    const dup = wallets.wallets.length !== labels.size;
    if (dup) issues.push({ file: 'wallets.yaml', path: 'wallets', kind: 'cross', message: 'duplicate wallet labels' });
    for (const h of holdings) {
      for (const w of h.wallets) {
        if (!labels.has(w)) {
          issues.push({ file: `holdings/${h.id}.yaml`, path: 'wallets', kind: 'cross', message: `wallet label "${w}" is not defined in wallets.yaml` });
        }
      }
    }
  }
  const seen = new Set<string>();
  for (const h of holdings) {
    if (seen.has(h.id)) issues.push({ file: `holdings/${h.id}.yaml`, path: 'id', kind: 'cross', message: `duplicate holding id "${h.id}"` });
    seen.add(h.id);
    const nodeIds = new Set(h.control_graph.map((n) => n.id));
    if (nodeIds.size !== h.control_graph.length) {
      issues.push({ file: `holdings/${h.id}.yaml`, path: 'control_graph', kind: 'cross', message: 'duplicate control_graph node ids' });
    }
    h.pending_actions.forEach((pa, i) => {
      if (!nodeIds.has(pa.node)) {
        issues.push({ file: `holdings/${h.id}.yaml`, path: `pending_actions[${i}].node`, kind: 'cross', message: `unknown control_graph node "${pa.node}"` });
      }
    });
    const feed = h.exposure.price_feed;
    if (feed.startsWith('chainlink:')) {
      const reg = registries['chainlink-feeds'] as ChainlinkFeeds | undefined;
      if (reg && !reg.feeds[feed.slice(10)]) {
        issues.push({ file: `holdings/${h.id}.yaml`, path: 'exposure.price_feed', kind: 'cross', message: `no feed "${feed.slice(10)}" in shared/chainlink-feeds.yaml` });
      }
    }
    if (h.kind === 'metamorpho' && !h.control_graph.some((n) => n.type === 'metamorpho')) {
      issues.push({ file: `holdings/${h.id}.yaml`, path: 'control_graph', kind: 'cross', message: 'kind metamorpho needs a control_graph node of type metamorpho' });
    }
  }

  const hard = issues.filter((i) => i.kind !== 'verify');
  if (hard.length > 0 || !sentinel || !wallets) throw new ConfigError(hard);

  const tokens = (registries['tokens'] as Tokens | undefined) ?? { tokens: {} };
  const feeds = (registries['chainlink-feeds'] as ChainlinkFeeds | undefined) ?? { feeds: {} };
  const poolsOf = (k: 'curve-pools' | 'uniswap-v3-pools'): Record<string, { address: string }> =>
    ((registries[k] as { pools: Record<string, { address: string }> } | undefined) ?? { pools: {} }).pools;
  const sentinelCfg = sentinel;

  return {
    dir,
    sentinel: sentinelCfg,
    wallets,
    holdings,
    registries: { chainlinkFeeds: feeds, tokens, curvePools: poolsOf('curve-pools'), uniswapV3Pools: poolsOf('uniswap-v3-pools') },
    warnings,
    threshold(holding, key) {
      return resolveThreshold(key, sentinelCfg.thresholds, holding?.thresholds);
    },
  };
}

/* ------------------------------------------------------------------ raw access (discover) */

export interface RawHolding {
  file: string;
  raw: RawYaml;
  /** Env-substituted, $ref-resolved, node-ref-resolved, not schema-validated. */
  resolved: Json;
  issues: ConfigIssue[];
}

/**
 * Lenient load of one holding: resolves env/$ref/references but does not require the whole
 * file (or the rest of the project) to validate. Used by `config discover`.
 */
export function loadRawHolding(dir: string, holdingId: string, opts: LoadOptions = {}): RawHolding {
  const env = loadEnv(opts);
  const project = readProject(dir);
  const issues: ConfigIssue[] = [];
  const entry = [...project.holdings.entries()].find(([name, r]) => {
    const id = isObject(r.data) ? r.data['id'] : undefined;
    return name === holdingId || id === holdingId;
  });
  if (!entry) {
    throw new ConfigError([{ file: path.join(dir, 'holdings'), path: holdingId, kind: 'io', message: `no holding "${holdingId}" in config/holdings/` }]);
  }
  const shared = new Map<string, Json>();
  for (const [name, raw] of project.shared) shared.set(name, substitute(raw, env, []));
  const raw = entry[1];
  const substituted = substitute(raw, env, issues);
  const resolved = resolveNodeRefs(resolveRefs(substituted, raw.file, shared, issues), raw.file, issues);
  return { file: raw.file, raw, resolved, issues };
}

export { ChainlinkFeedsSchema, PoolRegistrySchema, TokensSchema };
