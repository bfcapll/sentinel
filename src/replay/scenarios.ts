import { encodeAbiParameters, keccak256, toBytes } from 'viem';
import type { Address, Hex } from '../config/schema.js';
import { EIP1967_SLOTS } from '../watchers/proxy.js';
import type { SyntheticScenario } from './synthetic.js';

/** Addresses used by fixtures/demo/config. Deliberately obvious fakes. */
export const DEMO = {
  token: '0x1111111111111111111111111111111111111111' as Address,
  wallet: '0x2222222222222222222222222222222222222222' as Address,
  implA: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as Address,
  implB: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as Address,
  adminX: '0xcccccccccccccccccccccccccccccccccccccccc' as Address,
  adminY: '0xdddddddddddddddddddddddddddddddddddddddd' as Address,
  holding: 'demo-proxy',
  from: 1000,
  to: 1040,
  implChangeBlock: 1020,
  adminChangeBlock: 1030,
} as const;

export const addressWord = (a: Address): Hex => `0x${'0'.repeat(24)}${a.slice(2).toLowerCase()}`;

const ADMIN_CHANGED_TOPIC0 = keccak256(toBytes('AdminChanged(address,address)'));

/**
 * Synthetic incident (PLAN.md §8.2 "storage-slot write without an Upgraded event"):
 *  - block 1020: the implementation slot changes with NO Upgraded event (state read must catch it)
 *  - block 1030: the admin slot changes WITH an AdminChanged event (event enriches with a tx hash)
 */
export function proxyUpgradeScenario(): SyntheticScenario {
  const T = DEMO.token;
  return {
    head: 1100,
    genesisTimestamp: 1_700_000_000,
    blockTime: 12,
    storage: [
      { address: T, slot: EIP1967_SLOTS.implementation, fromBlock: 0, value: addressWord(DEMO.implA) },
      { address: T, slot: EIP1967_SLOTS.implementation, fromBlock: DEMO.implChangeBlock, value: addressWord(DEMO.implB) },
      { address: T, slot: EIP1967_SLOTS.admin, fromBlock: 0, value: addressWord(DEMO.adminX) },
      { address: T, slot: EIP1967_SLOTS.admin, fromBlock: DEMO.adminChangeBlock, value: addressWord(DEMO.adminY) },
    ],
    logs: [
      {
        block: DEMO.adminChangeBlock,
        address: T,
        topics: [ADMIN_CHANGED_TOPIC0],
        data: encodeAbiParameters([{ type: 'address' }, { type: 'address' }], [DEMO.adminX, DEMO.adminY]),
        txHash: keccak256(toBytes('demo-admin-change-tx')),
      },
    ],
    balances: { [T.toLowerCase()]: { [DEMO.wallet.toLowerCase()]: [{ fromBlock: 0, value: 1_000_000n * 10n ** 6n }] } },
  };
}
