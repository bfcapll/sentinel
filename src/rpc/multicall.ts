import { decodeFunctionResult, encodeFunctionData, parseAbi, type Abi } from 'viem';
import { mainnet } from 'viem/chains';
import type { Address, Hex } from '../config/schema.js';
import type { ReadCall, ReadResult } from './types.js';

export const MULTICALL3: Address = mainnet.contracts.multicall3.address;

const MULTICALL3_ABI = parseAbi([
  'function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[] returnData)',
]);

export interface EncodedCall {
  target: Address;
  callData: Hex;
}

export function encodeRead(call: ReadCall): Hex {
  return encodeFunctionData({ abi: call.abi as Abi, functionName: call.functionName, args: call.args as unknown[] | undefined });
}

/** Encode a batch as one `aggregate3` eth_call payload (every inner call allowed to fail). */
export function encodeAggregate3(calls: ReadCall[]): Hex {
  return encodeFunctionData({
    abi: MULTICALL3_ABI,
    functionName: 'aggregate3',
    args: [calls.map((c) => ({ target: c.address, allowFailure: true, callData: encodeRead(c) }))],
  });
}

export function decodeAggregate3(calls: ReadCall[], data: Hex): ReadResult[] {
  const out = decodeFunctionResult({ abi: MULTICALL3_ABI, functionName: 'aggregate3', data }) as ReadonlyArray<{
    success: boolean;
    returnData: Hex;
  }>;
  return calls.map((c, i) => {
    const r = out[i];
    if (!r) return { ok: false, error: 'missing multicall result' };
    if (!r.success) return { ok: false, error: `call reverted: ${c.functionName} @ ${c.address}` };
    try {
      return {
        ok: true,
        value: decodeFunctionResult({ abi: c.abi as Abi, functionName: c.functionName, data: r.returnData }),
      };
    } catch (e) {
      return { ok: false, error: `decode failed for ${c.functionName} @ ${c.address}: ${(e as Error).message.split('\n')[0]}` };
    }
  });
}
