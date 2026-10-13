import { formatUnits, parseAbi } from 'viem';
import type { Address, Holding } from '../config/schema.js';
import { parseExitSize, parsePriceFeed } from '../config/schema.js';
import type { LoadedConfig } from '../config/loader.js';
import type { ConditionState } from '../rules/types.js';
import type { ReadMap, StateRead } from '../watchers/types.js';

const ERC20 = parseAbi(['function balanceOf(address) view returns (uint256)', 'function totalSupply() view returns (uint256)']);
const ERC4626 = parseAbi(['function totalAssets() view returns (uint256)']);
const CHAINLINK = parseAbi([
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
]);

const VAULT_KINDS = new Set<Holding['kind']>(['metamorpho', 'morpho-vault-v2']);

export interface PositionOverride {
  /** `--position-usd`: skip on-chain balances and use this exposure. */
  positionUsd?: number;
  /** `--as-wallet`: read balances for this address instead of the configured wallets. */
  asWallet?: Address;
}

export interface WalletBalance {
  label: string;
  address: Address;
  /** Raw token units (shares for vault kinds). */
  balance: bigint;
}

export interface PositionSummary {
  holdingId: string;
  exposureUsd: number | null;
  /** Human-readable breakdown for the alert "Exposure" line, e.g. "main: 12,345.67 steakUSDC". */
  note: string;
  wallets: WalletBalance[];
  /** Position in the underlying (vault kinds) or the token itself, as a decimal number. */
  amount: number | null;
  price: number | null;
  exitSizeUsd: number | null;
  /** Non-fatal problems (unsupported price source, stale feed...). */
  warnings: string[];
}

export interface ExitPath {
  open: boolean;
  reason: string;
}

function resolvedWallets(h: Holding, cfg: LoadedConfig, o: PositionOverride): Array<{ label: string; address: Address }> {
  if (o.asWallet) return [{ label: 'as-wallet', address: o.asWallet }];
  return h.wallets.map((label) => {
    const w = cfg.wallets.wallets.find((x) => x.label === label);
    if (!w) throw new Error(`wallet "${label}" missing from wallets.yaml (config check should have caught this)`);
    return { label, address: w.address };
  });
}

/** Reads needed to value the position at the pinned block. Joins the cycle's single multicall. */
export function planPosition(h: Holding, cfg: LoadedConfig, o: PositionOverride = {}): StateRead[] {
  if (o.positionUsd !== undefined) return [];
  const reads: StateRead[] = [];
  for (const w of resolvedWallets(h, cfg, o)) {
    reads.push({
      id: `position/balance/${w.label}`,
      kind: 'call',
      address: h.asset.address,
      abi: ERC20,
      functionName: 'balanceOf',
      args: [w.address],
    });
  }
  if (VAULT_KINDS.has(h.kind)) {
    reads.push({ id: 'position/totalSupply', kind: 'call', address: h.asset.address, abi: ERC20, functionName: 'totalSupply' });
    reads.push({ id: 'position/totalAssets', kind: 'call', address: h.asset.address, abi: ERC4626, functionName: 'totalAssets' });
  }
  const feed = parsePriceFeed(h.exposure.price_feed);
  if (feed.kind === 'chainlink') {
    const f = cfg.registries.chainlinkFeeds.feeds[feed.pair];
    if (f) reads.push({ id: 'position/price', kind: 'call', address: f.address, abi: CHAINLINK, functionName: 'latestRoundData' });
  }
  return reads;
}

const fmt = (n: number): string => n.toLocaleString('en-US', { maximumFractionDigits: 2, minimumFractionDigits: 2 });

/**
 * Exposure from on-chain balances (PLAN.md principle 3). Vault kinds convert shares to assets with
 * the ERC-4626 virtual-offset formula that MetaMorpho / OZ use for `convertToAssets`:
 *   assets = shares * (totalAssets + 1) / (totalSupply + 10 ** (assetDecimals - loanDecimals))
 * so the whole position is valued from the same multicall as everything else at block T.
 */
export function computePosition(h: Holding, cfg: LoadedConfig, reads: ReadMap, o: PositionOverride = {}): PositionSummary {
  const warnings: string[] = [];
  const feed = parsePriceFeed(h.exposure.price_feed);
  const exit = parseExitSize(h.exposure.exit_size);
  const finish = (exposureUsd: number | null, extra: Partial<PositionSummary>): PositionSummary => ({
    holdingId: h.id,
    exposureUsd,
    note: '',
    wallets: [],
    amount: null,
    price: null,
    exitSizeUsd: exposureUsd === null ? null : exit.kind === 'usd' ? exit.value : (exposureUsd * exit.value) / 100,
    warnings,
    ...extra,
  });

  if (o.positionUsd !== undefined) {
    return finish(o.positionUsd, { note: `fixed position (--position-usd) $${fmt(o.positionUsd)}`, price: null });
  }

  let price: number | null = null;
  if (feed.kind === 'const') price = feed.value;
  else if (feed.kind === 'chainlink') {
    const reg = cfg.registries.chainlinkFeeds.feeds[feed.pair];
    const r = reads.get('position/price');
    if (!reg || !r || !r.ok) warnings.push(`price feed ${feed.pair} unreadable${r && !r.ok ? `: ${r.error}` : ''}`);
    else {
      const [, answer, , updatedAt] = r.value as readonly [bigint, bigint, bigint, bigint, bigint];
      if (answer <= 0n) warnings.push(`price feed ${feed.pair} returned a non-positive answer`);
      else price = Number(formatUnits(answer, reg.decimals));
      void updatedAt; // staleness is the oracle watcher's job (Phase 3)
    }
  } else warnings.push('nav-oracle price source is implemented with the rwa watcher (Phase 3); exposure unknown');

  const wallets: WalletBalance[] = [];
  for (const w of resolvedWallets(h, cfg, o)) {
    const r = reads.get(`position/balance/${w.label}`);
    if (!r || !r.ok) {
      warnings.push(`balanceOf(${w.label}) unreadable${r && !r.ok ? `: ${r.error}` : ''}`);
      return finish(null, { wallets, price, note: 'balance unreadable' });
    }
    wallets.push({ label: w.label, address: w.address, balance: r.value as bigint });
  }
  const shares = wallets.reduce((a, w) => a + w.balance, 0n);

  let amount: number;
  if (VAULT_KINDS.has(h.kind)) {
    const loan = h.asset.loan_token;
    const ts = reads.get('position/totalSupply');
    const ta = reads.get('position/totalAssets');
    if (!loan || !ts?.ok || !ta?.ok) {
      warnings.push('vault conversion unavailable (missing loan_token or totalSupply/totalAssets read)');
      return finish(null, { wallets, price, note: 'vault conversion unavailable' });
    }
    const offset = 10n ** BigInt(Math.max(0, h.asset.decimals - loan.decimals));
    const assets = (shares * ((ta.value as bigint) + 1n)) / ((ts.value as bigint) + offset);
    amount = Number(formatUnits(assets, loan.decimals));
  } else {
    amount = Number(formatUnits(shares, h.asset.decimals));
  }

  const breakdown = wallets.map((w) => `${w.label}: ${fmt(Number(formatUnits(w.balance, h.asset.decimals)))} ${h.asset.symbol}`).join(', ');
  const usd = price === null ? null : amount * price;
  return finish(usd, { wallets, amount, price, note: breakdown });
}

/** Exit path is CLOSED while any open condition for the holding is marked exit-blocking. */
export function computeExitPath(holdingId: string, states: Iterable<ConditionState>): ExitPath {
  const blockers: string[] = [];
  for (const s of states) {
    if (s.holding === holdingId && s.status === 'open' && s.exitBlocking) blockers.push(s.context?.title ?? s.key);
  }
  if (blockers.length === 0) return { open: true, reason: 'no exit-blocking condition is open' };
  return { open: false, reason: blockers.join('; ') };
}
