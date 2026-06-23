import { ZERO_ADDRESS, KNOWN_FACTORIES_SET } from "./constants";

function isLikelyGarbagePairInternal(t0: string, t1: string): boolean {
  return (
    !t0 || !t1 ||
    t0 === t1 ||
    t0 === ZERO_ADDRESS ||
    t1 === ZERO_ADDRESS ||
    KNOWN_FACTORIES_SET.has(t0) ||
    KNOWN_FACTORIES_SET.has(t1)
  );
}

/**
 * Basic defensive guards for pool discovery.
 * Envio address_format: lowercase — event params are already normalized.
 */
export function isLikelyGarbagePair(token0: string, token1: string): boolean {
  return isLikelyGarbagePairInternal(token0, token1);
}

/**
 * Shared guard for factory PairCreated / PoolCreated (contractRegister + onEvent).
 * Skips zero-address, identical tokens, indexed factories used as tokens, and
 * the emitting factory address as either token.
 */
export function shouldSkipFactoryPool(token0: string, token1: string, factoryAddr: string): boolean {
  if (token0 === factoryAddr || token1 === factoryAddr) return true;
  return isLikelyGarbagePairInternal(token0, token1);
}
