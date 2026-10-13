import { getAddress, isAddress } from 'viem';
import { z } from 'zod';
import { THRESHOLD_KEYS } from '../rules/defaults.js';

/* ------------------------------------------------------------------ primitives */

export type Address = `0x${string}`;
export type Hex = `0x${string}`;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** 20-byte address. Mixed-case input must carry a valid EIP-55 checksum. Output is checksummed. */
export const AddressSchema = z
  .string()
  .regex(ADDRESS_RE, 'must be a 0x-prefixed 20-byte hex address')
  .refine((a) => isAddress(a), 'bad EIP-55 checksum (use all-lowercase or the exact checksummed form)')
  .transform((a) => getAddress(a) as Address)
  .describe('Ethereum address (0x + 40 hex). Mixed case must be a valid EIP-55 checksum.');

export const Hex32Schema = z
  .string()
  .regex(/^0x[0-9a-fA-F]{64}$/, 'must be a 0x-prefixed 32-byte hex value')
  .transform((h) => h.toLowerCase() as Hex)
  .describe('32-byte hex value (market id, storage slot, role hash).');

const Slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'lowercase letters, digits and dashes only')
  .describe('Lowercase slug.');

const PercentString = z.string().regex(/^\d+(\.\d+)?%$/, 'percent like "100%"');

const DurationString = z
  .string()
  .regex(/^\d+(s|m|h|d)$/, 'duration like "90s", "15m", "6h", "7d"')
  .describe('Duration: integer + s|m|h|d.');

const Decimals = z.number().int().min(0).max(36);

/* ------------------------------------------------------------------ thresholds */

export const ThresholdSpecSchema = z
  .strictObject({
    p0: z.number().optional(),
    p1: z.number().optional(),
    p2: z.number().optional(),
    direction: z.enum(['above', 'below']).optional(),
    unit: z.string().optional(),
    persistence_blocks: z.number().int().min(0).optional(),
    persistence_cycles: z.number().int().min(1).optional(),
    resolve_factor: z.number().positive().optional(),
    resolve_cycles: z.number().int().min(1).optional(),
    cooldown_s: z.number().int().min(0).optional(),
  })
  .describe('Override of a default threshold (PLAN.md §6.2). Only the fields you set are overridden.');

export const ThresholdOverridesSchema = z
  .record(z.string(), ThresholdSpecSchema)
  .superRefine((rec, ctx) => {
    for (const k of Object.keys(rec)) {
      if (!(THRESHOLD_KEYS as string[]).includes(k)) {
        ctx.addIssue({
          code: 'custom',
          path: [k],
          message: `unknown threshold key "${k}"; valid keys: ${THRESHOLD_KEYS.join(', ')}`,
        });
      }
    }
  })
  .describe('Threshold overrides keyed by rule key, e.g. `liquidity.ratio`.');

/* ------------------------------------------------------------------ control graph */

export const NODE_TYPES = [
  'proxy',
  'safe',
  'timelock',
  'access-control',
  'owned',
  'metamorpho',
  'morpho-blue',
  'public-allocator',
  'stablecoin-issuer',
] as const;

export const ProxyExpectSchema = z
  .strictObject({
    implementation: AddressSchema.optional(),
    admin: AddressSchema.optional(),
    beacon: AddressSchema.optional(),
  })
  .describe(
    'Expected EIP-1967 slot values. Omitted fields are pinned to the first observed value (trust on first use) and alert on any later change. 0x0 means "slot must stay empty".',
  );

const ExpectLoose = z.record(z.string(), z.unknown());

const NodeCommon = {
  id: Slug.describe('Node id, unique within the holding. Referenced by pending_actions and <id.expect.field> references.'),
  address: AddressSchema,
  label: z.string().optional(),
  proxy: ProxyExpectSchema.optional().describe('Present when this contract sits behind an EIP-1967 proxy; enables the proxy watcher on it.'),
};

export const ControlNodeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    ...NodeCommon,
    type: z.literal('proxy'),
    expect: ProxyExpectSchema.default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('safe'),
    expect: z
      .strictObject({
        threshold_min: z.number().int().min(1).optional(),
        owners_known: z.boolean().optional(),
        owners: z.array(AddressSchema).optional(),
        modules: z.array(AddressSchema).optional(),
        guard: AddressSchema.optional(),
      })
      .default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('timelock'),
    expect: z.strictObject({ min_delay_s: z.number().int().min(0).optional() }).default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('access-control'),
    expect: z
      .strictObject({
        roles: z
          .array(z.strictObject({ role: Hex32Schema, name: z.string().optional(), holders: z.array(AddressSchema) }))
          .optional(),
      })
      .default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('owned'),
    expect: z.strictObject({ owner: AddressSchema.optional(), pending_owner: AddressSchema.optional() }).default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('metamorpho'),
    expect: z
      .strictObject({
        owner: AddressSchema,
        curator: AddressSchema,
        guardian: AddressSchema,
        allocators: z.array(AddressSchema).default([]),
        timelock_s: z.number().int().min(0),
        fee_bps_max: z.number().int().min(0).max(10_000).optional(),
      })
      .describe('Expected MetaMorpho roles and parameters. Any deviation is a control-plane condition.'),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('morpho-blue'),
    expect: z
      .strictObject({ owner: AddressSchema.optional(), fee_recipient: AddressSchema.optional() })
      .default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('public-allocator'),
    expect: z.strictObject({ admin: AddressSchema.optional(), fee: z.string().optional() }).default({}),
  }),
  z.strictObject({
    ...NodeCommon,
    type: z.literal('stablecoin-issuer'),
    expect: z
      .strictObject({
        owner: AddressSchema.optional(),
        pauser: AddressSchema.optional(),
        blacklister: AddressSchema.optional(),
        master_minter: AddressSchema.optional(),
      })
      .default({}),
  }),
]);
export type ControlNode = z.infer<typeof ControlNodeSchema>;

/** A shared control-graph node: same as ControlNode but with no `id` (the holding supplies it). */
export const SharedNodeSchema = z.discriminatedUnion(
  'type',
  ControlNodeSchema.options.map((o) => o.omit({ id: true })) as unknown as [
    z.ZodObject<z.ZodRawShape>,
    ...z.ZodObject<z.ZodRawShape>[],
  ],
);

/* ------------------------------------------------------------------ holding */

export const HOLDING_KINDS = [
  'metamorpho',
  'morpho-vault-v2',
  'aave-v3',
  'curve-lp',
  'uniswap-v3-lp',
  'rwa-token',
] as const;

const PriceFeed = z
  .string()
  .regex(/^(chainlink:[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|const:\d+(\.\d+)?|nav-oracle)$/, 'chainlink:<PAIR> | const:<number> | nav-oracle')
  .describe('Price source for exposure: `chainlink:USDC/USD` (resolved via shared/chainlink-feeds), `const:1.0`, or `nav-oracle`.');

const ExitSize = z
  .union([PercentString, z.number().positive()])
  .default('100%')
  .describe('Exit size used for peg checks and liquidity ratios: a percent of the position ("100%") or an absolute USD amount (number).');

export const HoldingSchema = z.strictObject({
  id: Slug.describe('Unique holding id; used in every condition key.'),
  enabled: z.boolean().default(true),
  chain: z.literal('ethereum').default('ethereum'),
  kind: z.enum(HOLDING_KINDS),
  asset: z.strictObject({
    address: AddressSchema.describe('The token / vault share you hold.'),
    decimals: Decimals,
    symbol: z.string().min(1),
    loan_token: z
      .strictObject({ address: AddressSchema, symbol: z.string().min(1), decimals: Decimals })
      .optional()
      .describe('Underlying asset (vault kinds).'),
  }),
  wallets: z.array(z.string().min(1)).min(1).describe('Wallet labels from wallets.yaml that hold this asset.'),
  exposure: z.strictObject({
    price_feed: PriceFeed,
    exit_size: ExitSize,
  }),
  control_graph: z.array(ControlNodeSchema).default([]),
  pending_actions: z
    .array(
      z.strictObject({
        source: z.enum(['timelock', 'morpho-vault', 'safe-tx-service']),
        node: z.string().describe('Control-graph node id this queue can affect.'),
      }),
    )
    .default([]),
  pauses: z.array(z.strictObject({ kind: z.string(), address: AddressSchema })).default([]),
  markets: z
    .strictObject({
      allowlist_mode: z.enum(['pin', 'open']).default('pin'),
      pinned: z.array(Hex32Schema).default([]).describe('Filled by `sentinel config discover <holding>`.'),
      collateral_allowlist: z.array(z.string()).default([]),
    })
    .optional(),
  oracles: z
    .strictObject({
      per_market: z.enum(['auto', 'manual']).default('auto'),
      staleness_margin: z.number().positive().default(1.25),
      divergence_bps: z.strictObject({ p1: z.number().positive(), p0: z.number().positive() }).optional(),
      explicit: z
        .array(
          z.strictObject({
            role: z.string(),
            address: AddressSchema,
            kind: z.enum(['morpho-chainlink-v2', 'chainlink', 'hardcoded', 'nav']),
            heartbeat_s: z.number().int().positive().optional(),
            feeds: z.array(AddressSchema).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
  peg: z
    .strictObject({
      pools: z
        .array(
          z.strictObject({
            kind: z.enum(['curve-ng', 'uniswap-v3', 'uniswap-v4']),
            address: AddressSchema,
            i: z.union([z.string(), z.number().int()]).optional(),
            j: z.union([z.string(), z.number().int()]).optional(),
            fee: z.number().int().optional(),
          }),
        )
        .default([]),
      sizes: z.array(PercentString).default(['25%', '50%', '100%']),
      persistence_blocks: z.number().int().min(0).default(15),
    })
    .optional(),
  liquidity: z
    .strictObject({
      metamorpho: z.strictObject({ compute: z.string().optional(), also: z.string().optional() }).optional(),
      thresholds: z.strictObject({ ratio_p1: z.number().positive(), ratio_p0: z.number().positive() }).optional(),
    })
    .optional(),
  flows: z
    .strictObject({
      windows: z.array(DurationString).default(['1h', '6h', '24h', '7d']),
      top_n_holders: z.number().int().positive().default(10),
      big_exit_pct_of_tvl: z.number().positive().optional(),
    })
    .optional(),
  thresholds: ThresholdOverridesSchema.default({}),
});
export type Holding = z.infer<typeof HoldingSchema>;

/* ------------------------------------------------------------------ wallets.yaml */

export const WalletsSchema = z.strictObject({
  telegram_user_id: z
    .number()
    .int()
    .positive()
    .describe('Your numeric Telegram user id. Only this user may press ACK / Snooze or run commands.'),
  wallets: z
    .array(z.strictObject({ label: z.string().min(1), address: AddressSchema }))
    .min(1)
    .describe('Your EOAs. Exposure is read on-chain from these.'),
});
export type WalletsConfig = z.infer<typeof WalletsSchema>;

/* ------------------------------------------------------------------ sentinel.yaml */

const HttpUrl = z.string().url().describe('http(s) URL. `${ENV}` references are substituted from the environment / .env.');
const WsUrl = z
  .string()
  .regex(/^wss?:\/\//, 'must be a ws:// or wss:// URL')
  .describe('WebSocket URL.');

const BotSchema = z.strictObject({
  token: z.string().min(10).describe('Bot token from BotFather (kept in .env).'),
  chat_id: z.union([z.string().min(1), z.number().int()]).describe('Chat / group id the bot posts to.'),
});

export const SentinelSchema = z.strictObject({
  chain: z.literal('ethereum').default('ethereum'),
  rpc: z.strictObject({
    primary: z.strictObject({ http: HttpUrl, ws: WsUrl.optional() }).describe('Alchemy: HTTPS + WSS.'),
    secondary: z.strictObject({ http: HttpUrl }).describe('Infura: cross-check + failover.'),
    canary: z.strictObject({ http: HttpUrl }).describe('dRPC public endpoint: eth_blockNumber only.'),
    confirmations: z.number().int().min(0).default(2),
    reorg_rescan_blocks: z.number().int().min(1).default(12),
    poll_interval_ms: z.number().int().min(500).default(4000).describe('HTTP head polling cadence (used when WS is silent).'),
    health_poll_ms: z.number().int().min(1000).default(12_000).describe('How often every provider (incl. the canary) is asked for eth_blockNumber for the lag rules.'),
    ws_silence_ms: z.number().int().min(1000).default(20_000).describe('Fall back to polling when WS delivers no head for this long.'),
    request_timeout_ms: z.number().int().min(500).default(10_000),
    lag: z
      .strictObject({
        max_block_diff: z.number().int().min(1).default(5),
        diff_secs: z.number().int().min(1).default(60),
        stall_secs: z.number().int().min(1).default(90),
        blind_secs: z.number().int().min(1).default(300),
      })
      .default({ max_block_diff: 5, diff_secs: 60, stall_secs: 90, blind_secs: 300 }),
  }),
  cycle: z
    .strictObject({
      slow_lane_secs: z.number().int().min(10).default(300),
      max_log_range: z.number().int().min(1).default(500),
      max_catchup_blocks: z.number().int().min(1).default(5000),
    })
    .default({ slow_lane_secs: 300, max_log_range: 500, max_catchup_blocks: 5000 }),
  telegram: z.strictObject({
    bots: z.strictObject({ p0: BotSchema, p1: BotSchema, p2: BotSchema }),
    repeat_minutes: z.number().positive().default(5),
    repeat_cap_hours: z.number().positive().default(24),
    global_repeat_min_interval_s: z.number().int().min(0).default(60),
    snooze_minutes: z.number().positive().default(60),
    digest: z
      .strictObject({
        time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:MM, 24h').default('09:00'),
        timezone: z.string().default('local').describe('IANA zone (e.g. America/New_York) or "local" for the host zone.'),
      })
      .default({ time: '09:00', timezone: 'local' }),
  }),
  healthchecks: z.strictObject({
    ping_url: HttpUrl.describe('Healthchecks.io ping URL; pinged only after a fully committed cycle.'),
    min_interval_s: z.number().int().min(1).default(60),
    timeout_ms: z.number().int().min(500).default(5000),
  }),
  etherscan: z.strictObject({
    api_key: z.string().min(1),
    base_url: z.string().url().default('https://api.etherscan.io/v2/api'),
  }),
  safe_tx_service: z.strictObject({
    api_key: z.string().min(1),
    base_url: z.string().url().default('https://api.safe.global/tx-service/eth/api'),
  }),
  explorer: z
    .strictObject({
      tx_url: z.string().default('https://etherscan.io/tx/{hash}'),
      block_url: z.string().default('https://etherscan.io/block/{number}'),
      address_url: z.string().default('https://etherscan.io/address/{address}'),
    })
    .default({
      tx_url: 'https://etherscan.io/tx/{hash}',
      block_url: 'https://etherscan.io/block/{number}',
      address_url: 'https://etherscan.io/address/{address}',
    }),
  store: z
    .strictObject({
      path: z.string().default('./data/sentinel.db'),
      backup_dir: z.string().default('./backups'),
      backup_keep: z.number().int().min(1).default(14),
    })
    .default({ path: './data/sentinel.db', backup_dir: './backups', backup_keep: 14 }),
  logging: z
    .strictObject({
      level: z.enum(['trace', 'debug', 'info', 'warn', 'error']).default('info'),
      file: z.string().optional().describe('Log file path; stdout when omitted (NSSM captures and rotates stdout).'),
    })
    .default({ level: 'info' }),
  thresholds: ThresholdOverridesSchema.default({}).describe('Global overrides of the default threshold table.'),
});
export type SentinelConfig = z.infer<typeof SentinelSchema>;

/* ------------------------------------------------------------------ shared registries */

export const ChainlinkFeedsSchema = z.strictObject({
  feeds: z.record(
    z.string(),
    z.strictObject({
      address: AddressSchema,
      decimals: Decimals,
      heartbeat_s: z.number().int().positive(),
      deviation_bps: z.number().positive().optional(),
    }),
  ),
});
export type ChainlinkFeeds = z.infer<typeof ChainlinkFeedsSchema>;

export const TokensSchema = z.strictObject({
  tokens: z.record(z.string(), z.strictObject({ address: AddressSchema, decimals: Decimals })),
});
export type Tokens = z.infer<typeof TokensSchema>;

export const PoolRegistrySchema = z.strictObject({
  pools: z.record(z.string(), z.strictObject({ address: AddressSchema, tokens: z.array(z.string()).optional(), fee: z.number().int().optional() })),
});

export const SHARED_REGISTRIES = {
  'chainlink-feeds': ChainlinkFeedsSchema,
  tokens: TokensSchema,
  'curve-pools': PoolRegistrySchema,
  'uniswap-v3-pools': PoolRegistrySchema,
} as const;
export type RegistryName = keyof typeof SHARED_REGISTRIES;

/* ------------------------------------------------------------------ helpers */

export type ParsedPriceFeed =
  | { kind: 'const'; value: number }
  | { kind: 'chainlink'; pair: string }
  | { kind: 'nav-oracle' };

export function parsePriceFeed(s: string): ParsedPriceFeed {
  if (s === 'nav-oracle') return { kind: 'nav-oracle' };
  if (s.startsWith('const:')) return { kind: 'const', value: Number(s.slice(6)) };
  if (s.startsWith('chainlink:')) return { kind: 'chainlink', pair: s.slice(10) };
  throw new Error(`bad price_feed "${s}"`);
}

export type ParsedExitSize = { kind: 'pct'; value: number } | { kind: 'usd'; value: number };

export function parseExitSize(v: string | number): ParsedExitSize {
  if (typeof v === 'number') return { kind: 'usd', value: v };
  return { kind: 'pct', value: Number(v.slice(0, -1)) };
}

export function parseDurationSeconds(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  if (!m) throw new Error(`bad duration "${s}"`);
  const n = Number(m[1]);
  return n * { s: 1, m: 60, h: 3600, d: 86_400 }[m[2] as 's' | 'm' | 'h' | 'd'];
}
