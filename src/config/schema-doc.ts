import { z } from 'zod';
import { DEFAULT_THRESHOLDS } from '../rules/defaults.js';
import {
  ChainlinkFeedsSchema,
  HoldingSchema,
  PoolRegistrySchema,
  SentinelSchema,
  SharedNodeSchema,
  TokensSchema,
  WalletsSchema,
} from './schema.js';

type JS = {
  type?: string | string[];
  properties?: Record<string, JS>;
  required?: string[];
  items?: JS;
  anyOf?: JS[];
  oneOf?: JS[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  description?: string;
  pattern?: string;
  additionalProperties?: boolean | JS;
  minimum?: number;
  exclusiveMinimum?: number;
  maximum?: number;
  format?: string;
};

const ADDRESS_PATTERN = '^0x[0-9a-fA-F]{40}$';
const BYTES32_PATTERN = '^0x[0-9a-fA-F]{64}$';

function typeOf(s: JS): string {
  if (s.const !== undefined) return `\`${JSON.stringify(s.const)}\``;
  if (s.enum) return s.enum.map((e) => `\`${String(e)}\``).join(' \\| ');
  if (s.pattern === ADDRESS_PATTERN) return 'address';
  if (s.pattern === BYTES32_PATTERN) return 'bytes32';
  const alts = s.anyOf ?? s.oneOf;
  if (alts) {
    const parts = [...new Set(alts.map(typeOf))];
    return parts.join(' \\| ');
  }
  if (s.type === 'array') return `list of ${s.items ? typeOf(s.items) : 'any'}`;
  if (s.type === 'object') {
    if (s.properties) return 'object';
    if (s.additionalProperties && typeof s.additionalProperties === 'object') return `map of ${typeOf(s.additionalProperties)}`;
    return 'object';
  }
  if (s.type === 'integer') return 'integer';
  if (s.type === 'string' && s.pattern) return `string (\`${s.pattern.replace(/\|/g, '\\|')}\`)`;
  return Array.isArray(s.type) ? s.type.join(' \\| ') : (s.type ?? 'any');
}

const cell = (t: string | undefined): string => (t ?? '').replace(/\n/g, ' ').replace(/\|/g, '\\|');

interface Section {
  path: string;
  schema: JS;
}

/** Collect every object schema reachable from `root`, with a dotted path. */
function collect(root: JS, base: string, out: Section[]): void {
  const visit = (s: JS, p: string): void => {
    const alts = s.anyOf ?? s.oneOf;
    if (alts) {
      alts.forEach((a, i) => visit(a, alts.length > 1 && a.type === 'object' ? `${p}#${variantName(a, i)}` : p));
      return;
    }
    if (s.type === 'array' && s.items) {
      visit(s.items, `${p}[]`);
      return;
    }
    if (s.type === 'object' && s.properties) {
      out.push({ path: p, schema: s });
      for (const [k, v] of Object.entries(s.properties)) visit(v, `${p}.${k}`);
    } else if (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object') {
      visit(s.additionalProperties, `${p}.<key>`);
    }
  };
  visit(root, base);
}

function variantName(s: JS, i: number): string {
  const t = s.properties?.['type'];
  return t?.const !== undefined ? `type=${String(t.const)}` : String(i);
}

function renderSection(sec: Section): string {
  const s = sec.schema;
  const req = new Set(s.required ?? []);
  const rows = Object.entries(s.properties ?? {}).map(([k, v]) => {
    const def = v.default !== undefined ? `\`${JSON.stringify(v.default)}\`` : '';
    return `| \`${k}\` | ${cell(typeOf(v))} | ${req.has(k) ? 'yes' : ''} | ${cell(def)} | ${cell(v.description)} |`;
  });
  return [`#### \`${sec.path}\``, '', s.description ? `${s.description}\n` : '', '| field | type | required | default | description |', '|---|---|---|---|---|', ...rows, ''].join('\n');
}

function renderSchema(title: string, anchorPath: string, schema: z.ZodType): string {
  const js = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as JS;
  const sections: Section[] = [];
  collect(js, anchorPath, sections);
  return [`### ${title}`, '', ...sections.map(renderSection)].join('\n');
}

function thresholdsTable(): string {
  const rows = Object.entries(DEFAULT_THRESHOLDS).map(([k, v]) => {
    const spec = v as Record<string, unknown>;
    const f = (x: unknown): string => (x === undefined ? '' : String(x));
    return `| \`${k}\` | ${f(spec['p0'])} | ${f(spec['p1'])} | ${f(spec['p2'])} | ${f(spec['direction'] ?? (spec['p0'] !== undefined || spec['p1'] !== undefined ? 'above' : ''))} | ${cell(f(spec['unit']))} | ${f(spec['persistence_blocks'])} | ${f(spec['persistence_cycles'])} | ${f(spec['resolve_factor'])} | ${f(spec['cooldown_s'])} |`;
  });
  return [
    '### Threshold keys and defaults',
    '',
    'Overridable globally in `sentinel.yaml` and per holding under `thresholds:` (only the fields you set are overridden). Binary conditions have no numbers: the watcher decides the tier (PLAN.md §6.2).',
    '',
    '| key | p0 | p1 | p2 | direction | unit | persistence blocks | persistence cycles | resolve factor | cooldown s |',
    '|---|---|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}

/** Build config/SCHEMA.md from the zod schemas, the single source of truth. */
export function generateSchemaMarkdown(): string {
  return [
    '# Sentinel configuration reference',
    '',
    '> Generated from `src/config/schema.ts` by `npm run gen:schema`. Do not edit by hand; a test fails if this file is stale.',
    '',
    '## How configuration is loaded',
    '',
    '- `config/sentinel.yaml` global settings; `config/wallets.yaml` your EOAs and Telegram user id; `config/shared/*.yaml` control graphs and registries defined once; `config/holdings/*.yaml` one file per position.',
    '- `${VAR}` and `${VAR:-default}` in any string are substituted from the environment, with `.env` filling in anything not already set. Unset or empty variables without a default are errors (names only, values are never printed).',
    '- `{ $ref: shared/<name>, ...overrides }` is replaced by the contents of `config/shared/<name>.yaml`, with local keys winning (deep merge).',
    '- `<node-id>` / `<node-id.expect.field>` resolve to an address inside the same holding (e.g. `address: <vault.expect.owner>`).',
    '- Values like `0x…`, `<unresolved>`, `TODO`, `CHANGEME` are unfilled placeholders: `sentinel config check` fails loudly until they are replaced. A `# verify` comment next to a value is reported as a warning until you remove it.',
    '- Unknown keys are errors (typos in a monitoring config must not pass silently).',
    '- Run `sentinel config check` after any edit.',
    '',
    '## Files',
    '',
    renderSchema('`config/sentinel.yaml`', 'sentinel', SentinelSchema),
    renderSchema('`config/wallets.yaml`', 'wallets', WalletsSchema),
    renderSchema('`config/holdings/<id>.yaml`', 'holding', HoldingSchema),
    renderSchema('`config/shared/<name>.yaml` (control-graph node, referenced with `$ref`)', 'shared-node', SharedNodeSchema),
    renderSchema('`config/shared/chainlink-feeds.yaml`', 'chainlink-feeds', ChainlinkFeedsSchema),
    renderSchema('`config/shared/tokens.yaml`', 'tokens', TokensSchema),
    renderSchema('`config/shared/curve-pools.yaml`, `uniswap-v3-pools.yaml`', 'pool-registry', PoolRegistrySchema),
    thresholdsTable(),
  ].join('\n');
}
