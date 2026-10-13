import { parseAbi } from 'viem';

/** Read surface of MetaMorpho v1.0/v1.1 used by discovery (PLAN.md §5.3, Appendix A.3). */
export const metaMorphoReadAbi = parseAbi([
  'function withdrawQueueLength() view returns (uint256)',
  'function withdrawQueue(uint256 index) view returns (bytes32)',
  'function supplyQueueLength() view returns (uint256)',
  'function supplyQueue(uint256 index) view returns (bytes32)',
  'function config(bytes32 id) view returns (uint184 cap, bool enabled, uint64 removableAt)',
]);

export const morphoBlueReadAbi = parseAbi([
  'function idToMarketParams(bytes32 id) view returns (address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)',
]);

export const erc20MetaAbi = parseAbi(['function symbol() view returns (string)', 'function decimals() view returns (uint8)']);
