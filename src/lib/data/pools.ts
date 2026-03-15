// Known pool addresses for supported trading pairs
// These are the highest-liquidity USDC pools on Ethereum mainnet

import { SUPPORTED_PAIRS } from '../constants';

export function getPoolConfig(pair: string) {
  return SUPPORTED_PAIRS.find(p => p.pair === pair || p.label === pair);
}

export function getAllPairs() {
  return SUPPORTED_PAIRS;
}
