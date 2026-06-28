import { ZERO_ADDRESS, KNOWN_FACTORIES_SET } from "./constants";

export function isLikelyGarbagePair(t0: string, t1: string): boolean {
  return (
    !t0 || !t1 ||
    t0 === t1 ||
    t0 === ZERO_ADDRESS ||
    t1 === ZERO_ADDRESS ||
    KNOWN_FACTORIES_SET.has(t0) ||
    KNOWN_FACTORIES_SET.has(t1)
  );
}

export function shouldSkipFactoryPool(token0: string, token1: string, factoryAddr: string): boolean {
  if (token0 === factoryAddr || token1 === factoryAddr) return true;
  return isLikelyGarbagePair(token0, token1);
}
