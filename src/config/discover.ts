import { writeFileSync } from 'node:fs';
import { isMap, isScalar, isSeq, type Document, type Node } from 'yaml';
import { erc20MetaAbi, metaMorphoReadAbi, morphoBlueReadAbi } from '../abi/morpho.js';
import { systemClock } from '../time.js';
import { silentLogger } from '../log.js';
import { buildLiveRpc } from '../rpc/factory.js';
import type { ChainReader, ReadCall } from '../rpc/types.js';
import { ConfigError, loadRawHolding, loadSentinelOnly, type LoadOptions } from './loader.js';
import { isObject, type ConfigIssue, type Json } from './yaml.js';
import { AddressSchema, Hex32Schema, type Address, type Hex } from './schema.js';

export interface DiscoveredMarket {
  id: Hex;
  loanToken: Address;
  collateralToken: Address;
  collateralSymbol: string;
  loanSymbol: string;
  oracle: Address;
  irm: Address;
  lltv: bigint;
  cap: bigint;
  enabled: boolean;
  removableAt: bigint;
  inSupplyQueue: boolean;
}

export interface DiscoverResult {
  holdingId: string;
  file: string;
  vault: Address;
  morphoBlue: Address;
  block: number;
  markets: DiscoveredMarket[];
  previouslyPinned: Hex[];
  added: Hex[];
  removed: Hex[];
  written: boolean;
}

const lltvPct = (l: bigint): string => `${(Number(l) / 1e16).toFixed(1)}%`;

function addressAt(resolved: Json, nodeType: string): Address | undefined {
  if (!isObject(resolved)) return undefined;
  const graph = resolved['control_graph'];
  if (!Array.isArray(graph)) return undefined;
  const node = graph.find((n) => isObject(n) && n['type'] === nodeType);
  const a = isObject(node) ? node['address'] : undefined;
  const parsed = AddressSchema.safeParse(a);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Pin the vault's withdrawQueue market ids (PLAN.md §5.2 `markets.pinned`) by reading the
 * queues and each market's params on-chain. Works on a holding that does not yet pass full
 * validation: it only needs the vault and Morpho Blue addresses to be filled in.
 */
export async function discoverMarkets(
  dir: string,
  holdingId: string,
  opts: LoadOptions & { dryRun?: boolean; reader?: ChainReader; block?: number } = {},
): Promise<DiscoverResult> {
  const raw = loadRawHolding(dir, holdingId, opts);
  const resolved = raw.resolved;
  const kind = isObject(resolved) ? resolved['kind'] : undefined;
  if (kind !== 'metamorpho') throw new ConfigError([{ file: raw.file, path: 'kind', kind: 'schema', message: `discover supports kind: metamorpho (this holding is ${String(kind)})` }]);

  const issues: ConfigIssue[] = [];
  const vault = addressAt(resolved, 'metamorpho');
  const morphoBlue = addressAt(resolved, 'morpho-blue');
  if (!vault) issues.push({ file: raw.file, path: 'control_graph[type=metamorpho].address', kind: 'placeholder', message: 'vault address missing or not filled in' });
  if (!morphoBlue) issues.push({ file: raw.file, path: 'control_graph[type=morpho-blue].address', kind: 'placeholder', message: 'Morpho Blue node missing or its address not filled in (shared/morpho-blue-mainnet)' });
  if (!vault || !morphoBlue) throw new ConfigError(issues);

  let reader = opts.reader;
  let block = opts.block;
  if (!reader) {
    const sentinel = loadSentinelOnly(dir, opts);
    reader = buildLiveRpc(sentinel, systemClock, silentLogger()).client;
    block ??= (await reader.getBlockNumber()) - sentinel.rpc.confirmations;
  }
  if (block === undefined) throw new Error('block required when a reader is supplied');

  const call = (address: Address, abi: ReadCall['abi'], functionName: string, args?: unknown[]): ReadCall => ({ address, abi, functionName, args });
  const val = <T>(r: { ok: boolean; value?: unknown; error?: string }, what: string): T => {
    if (!r.ok) throw new Error(`${what}: ${r.error}`);
    return r.value as T;
  };

  const [wLen, sLen] = await reader.multicall(
    [call(vault, metaMorphoReadAbi, 'withdrawQueueLength'), call(vault, metaMorphoReadAbi, 'supplyQueueLength')],
    block,
  );
  const wn = Number(val<bigint>(wLen!, 'withdrawQueueLength'));
  const sn = Number(val<bigint>(sLen!, 'supplyQueueLength'));
  const queueCalls: ReadCall[] = [
    ...Array.from({ length: wn }, (_, i) => call(vault, metaMorphoReadAbi, 'withdrawQueue', [BigInt(i)])),
    ...Array.from({ length: sn }, (_, i) => call(vault, metaMorphoReadAbi, 'supplyQueue', [BigInt(i)])),
  ];
  const queueRes = await reader.multicall(queueCalls, block);
  const ids = queueRes.map((r, i) => val<Hex>(r, `queue[${i}]`));
  const withdrawIds = ids.slice(0, wn);
  const supplyIds = new Set(ids.slice(wn));
  const uniqueIds = [...new Set(withdrawIds)];

  const paramRes = await reader.multicall(uniqueIds.map((id) => call(morphoBlue, morphoBlueReadAbi, 'idToMarketParams', [id])), block);
  const cfgRes = await reader.multicall(uniqueIds.map((id) => call(vault, metaMorphoReadAbi, 'config', [id])), block);
  const params = paramRes.map((r, i) => val<readonly [Address, Address, Address, Address, bigint]>(r, `idToMarketParams(${uniqueIds[i]})`));
  const tokens = [...new Set(params.flatMap((p) => [p[0], p[1]]))];
  const symRes = await reader.multicall(tokens.map((t) => call(t, erc20MetaAbi, 'symbol')), block);
  const symbols = new Map(tokens.map((t, i) => [t, symRes[i]!.ok ? String(symRes[i]!.value) : '?'] as const));

  const markets: DiscoveredMarket[] = uniqueIds.map((id, i) => {
    const [loanToken, collateralToken, oracle, irm, lltv] = params[i]!;
    const cfg = val<readonly [bigint, boolean, bigint]>(cfgRes[i]!, `config(${id})`);
    return {
      id,
      loanToken,
      collateralToken,
      collateralSymbol: symbols.get(collateralToken) ?? '?',
      loanSymbol: symbols.get(loanToken) ?? '?',
      oracle,
      irm,
      lltv,
      cap: cfg[0],
      enabled: cfg[1],
      removableAt: cfg[2],
      inSupplyQueue: supplyIds.has(id),
    };
  });

  const doc = raw.raw.doc;
  const previouslyPinned = readPinned(doc);
  const added = uniqueIds.filter((id) => !previouslyPinned.includes(id));
  const removed = previouslyPinned.filter((id) => !uniqueIds.includes(id));

  let written = false;
  if (!opts.dryRun) {
    writePinned(doc, markets);
    writeFileSync(raw.file, doc.toString());
    written = true;
  }
  return { holdingId, file: raw.file, vault, morphoBlue, block, markets, previouslyPinned, added, removed, written };
}

function readPinned(doc: Document): Hex[] {
  const node = doc.getIn(['markets', 'pinned']);
  if (!isSeq(node)) return [];
  return node.items
    .map((i) => (isScalar(i) ? String(i.value) : ''))
    .filter((s) => Hex32Schema.safeParse(s).success)
    .map((s) => s.toLowerCase() as Hex);
}

/** Replace `markets.pinned`, keeping the rest of the file (comments included) untouched. */
function writePinned(doc: Document, markets: DiscoveredMarket[]): void {
  const seq = doc.createNode(markets.map((m) => m.id));
  if (isSeq(seq)) {
    seq.items.forEach((item, i) => {
      const m = markets[i]!;
      (item as Node).comment = ` ${m.collateralSymbol}/${m.loanSymbol} lltv ${lltvPct(m.lltv)} oracle ${m.oracle}${m.enabled ? '' : ' (disabled)'}`;
    });
  }
  if (!isMap(doc.get('markets'))) doc.set('markets', doc.createNode({ allowlist_mode: 'pin' }));
  doc.setIn(['markets', 'pinned'], seq);
}
