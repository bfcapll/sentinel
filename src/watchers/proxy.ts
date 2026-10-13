import { decodeEventLog, getAddress, parseAbi, toEventSelector, type Hex as ViemHex } from 'viem';
import type { Address, ControlNode, Hex, Holding } from '../config/schema.js';
import type { RpcLog } from '../rpc/types.js';
import type { Sample } from '../rules/types.js';
import type { FoldInput, LogRequest, StateRead, WatchContext, WatchPlan, Watcher, WatcherOutput } from './types.js';

/** EIP-1967 storage slots (PLAN.md Appendix A.3, Proxies). */
export const EIP1967_SLOTS = {
  implementation: '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc',
  admin: '0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103',
  beacon: '0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50',
} as const satisfies Record<string, Hex>;

type SlotField = keyof typeof EIP1967_SLOTS;
const FIELDS = Object.keys(EIP1967_SLOTS) as SlotField[];

const PROXY_EVENTS = parseAbi([
  'event Upgraded(address indexed implementation)',
  'event AdminChanged(address previousAdmin, address newAdmin)',
  'event BeaconUpgraded(address indexed beacon)',
]);

const TOPIC0 = {
  implementation: toEventSelector(PROXY_EVENTS[0]),
  admin: toEventSelector(PROXY_EVENTS[1]),
  beacon: toEventSelector(PROXY_EVENTS[2]),
} as const satisfies Record<SlotField, ViemHex>;

const ZERO: Address = '0x0000000000000000000000000000000000000000';

const readId = (nodeId: string, field: SlotField): string => `${nodeId}/${field}`;

/** The proxy-watched nodes of a holding: `type: proxy` nodes and any node with a `proxy:` block. */
export function proxyNodes(h: Holding): Array<{ node: ControlNode; expect: Partial<Record<SlotField, Address>> }> {
  const out: Array<{ node: ControlNode; expect: Partial<Record<SlotField, Address>> }> = [];
  for (const node of h.control_graph) {
    if (node.type === 'proxy') out.push({ node, expect: node.expect });
    else if (node.proxy) out.push({ node, expect: node.proxy });
  }
  return out;
}

/** Last 20 bytes of a 32-byte slot word. */
export function slotToAddress(word: Hex): Address {
  const hex = word.toLowerCase().replace(/^0x/, '').padStart(64, '0');
  return getAddress(`0x${hex.slice(24)}`);
}

/**
 * Phase 0 stub watcher: reads the three EIP-1967 slots of every proxy node every cycle and
 * raises `proxy.impl_changed` (P0) when a slot differs from the configured expectation, or from
 * its first-observed value when no expectation is configured. State is the source of truth; the
 * Upgraded/AdminChanged/BeaconUpgraded events only enrich the alert with a tx hash.
 */
export const proxyWatcher: Watcher = {
  name: 'proxy',
  p0Class: true,

  appliesTo: (h) => proxyNodes(h).length > 0,

  plan(ctx: WatchContext): WatchPlan {
    const reads: StateRead[] = [];
    const logs: LogRequest[] = [];
    for (const { node } of proxyNodes(ctx.holding)) {
      for (const f of FIELDS) {
        reads.push({ id: readId(node.id, f), kind: 'storage', address: node.address, slot: EIP1967_SLOTS[f] });
      }
      logs.push({ address: node.address, topics: [TOPIC0.implementation, TOPIC0.admin, TOPIC0.beacon] });
    }
    return { reads, logs };
  },

  fold({ ctx, block, reads, logs, prev }: FoldInput): WatcherOutput {
    const h = ctx.holding;
    const spec = ctx.threshold('proxy.impl_changed');
    const out: WatcherOutput = { samples: [], observations: [], snapshots: [] };

    for (const { node, expect } of proxyNodes(h)) {
      for (const f of FIELDS) {
        const word = reads.require<Hex>(readId(node.id, f));
        const observed = slotToAddress(word);
        const baselineKey = `${h.id}/proxy/${node.id}/${f}/baseline`;
        const configured = expect[f];
        const baseline = configured ?? (prev(baselineKey) as Address | undefined);
        if (baseline === undefined) out.snapshots.push({ key: baselineKey, value: observed });
        const expected: Address = baseline ?? observed;
        const changed = observed !== expected;

        const match = changed ? findEvent(logs, node.address, f, observed) : undefined;
        const decoded = changed
          ? match
            ? `${EVENT_NAME[f]}(${match.argName}=${observed}); confirmed by ${SLOT_NAME[f]} slot read`
            : `EIP-1967 ${SLOT_NAME[f]} slot now ${observed}; no ${EVENT_NAME[f]} event seen, detected by slot read only`
          : undefined;

        const sample: Sample = {
          key: `${h.id}/proxy/${node.id}/${f}`,
          holding: h.id,
          watcher: 'proxy',
          rule: 'proxy.impl_changed',
          tier: changed ? 'P0' : null,
          clear: !changed,
          clearReason: configured
            ? `slot matches configured expectation ${observed}`
            : `slot matches pinned baseline ${observed}`,
          persistence: { blocks: spec.persistence_blocks ?? 1, cycles: spec.persistence_cycles ?? 1 },
          resolveCycles: spec.resolve_cycles ?? 1,
          cooldownS: spec.cooldown_s ?? 0,
          context: {
            title: `${SLOT_NAME[f]} slot changed on ${node.id}`,
            detail: changed
              ? `expected ${expected === ZERO ? '0x0 (empty)' : expected}\nobserved ${observed === ZERO ? '0x0 (empty)' : observed}\n${
                  configured ? 'expected value comes from config' : 'expected value is the pinned first observation'
                }. Update config to acknowledge.`
              : undefined,
            decoded,
            address: node.address,
            block: block.number,
            ...(match ? { txHash: match.log.transactionHash, logIndex: match.log.logIndex, block: match.log.blockNumber } : {}),
          },
        };
        out.samples.push(sample);

        if (changed) {
          out.observations.push({
            kind: `proxy.${f}_changed`,
            payload: { node: node.id, address: node.address, slot: EIP1967_SLOTS[f], expected, observed, configured: !!configured },
            ...(match ? { txHash: match.log.transactionHash, logIndex: match.log.logIndex } : {}),
            block: block.number,
          });
        }
      }
    }
    // Events that decode but have no matching state change are still audit-worthy (e.g. an
    // upgrade to the same implementation): record them without alerting.
    for (const log of logs) {
      const d = decodeProxyLog(log);
      if (d) {
        out.observations.push({
          kind: `proxy.event.${d.eventName}`,
          payload: { address: log.address, args: d.args },
          txHash: log.transactionHash,
          logIndex: log.logIndex,
          block: log.blockNumber,
        });
      }
    }
    return out;
  },
};

const SLOT_NAME: Record<SlotField, string> = {
  implementation: 'implementation',
  admin: 'admin',
  beacon: 'beacon',
};

const EVENT_NAME: Record<SlotField, string> = {
  implementation: 'Upgraded',
  admin: 'AdminChanged',
  beacon: 'BeaconUpgraded',
};

function decodeProxyLog(log: RpcLog): { eventName: string; args: unknown } | undefined {
  try {
    const d = decodeEventLog({ abi: PROXY_EVENTS, data: log.data, topics: log.topics as [ViemHex, ...ViemHex[]] });
    return { eventName: d.eventName, args: JSON.parse(JSON.stringify(d.args, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))) };
  } catch {
    return undefined;
  }
}

function findEvent(
  logs: RpcLog[],
  address: Address,
  field: SlotField,
  observed: Address,
): { log: RpcLog; argName: string } | undefined {
  for (const log of [...logs].reverse()) {
    if (log.address.toLowerCase() !== address.toLowerCase() || log.topics[0]?.toLowerCase() !== TOPIC0[field].toLowerCase()) continue;
    const d = decodeProxyLog(log);
    const args = d?.args as Record<string, string> | undefined;
    const value = field === 'implementation' ? args?.['implementation'] : field === 'admin' ? args?.['newAdmin'] : args?.['beacon'];
    if (value && value.toLowerCase() === observed.toLowerCase()) {
      return { log, argName: field === 'admin' ? 'newAdmin' : field === 'beacon' ? 'beacon' : 'newImplementation' };
    }
  }
  return undefined;
}
