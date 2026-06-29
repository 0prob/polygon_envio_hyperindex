/**
 * Centralized constants for the arbitrage bot and indexer.
 * Source of truth for this repo: src/utils/constants.ts
 */

export type Address = `0x${string}`;

/** Clamp ERC-20 decimals to uint8 range; default 18 when unknown/invalid. */
export function safeDecimals(value: unknown, fallback = 18): number {
  if (value == null) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0 || n > 255) return fallback;
  return Math.trunc(n);
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Polygon canonical addresses. All lowercase. */

// Token addresses
export const WMATIC: Address = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
export const WETH: Address = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
/** Native USDC (Circle) */
export const USDC: Address = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
/** Bridged USDC (USDC.e / PoS) */
export const USDC_E: Address = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
export const USDT: Address = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
export const DAI: Address = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063";
export const WBTC: Address = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
const LINK: Address = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39";
const AAVE: Address = "0xd6df932a45c0f255f85145f286ea0b292b21c90b";
const CRV: Address = "0x172370d5cd63279efa6d502dab29171933a610af";
const BAL: Address = "0x9a71012b13ca4d3d0cdcbc8942ec6c4e9e0e6c8c";
const UNI: Address = "0xb33eaad8d922b1083446dc23f610c2567fb5180f";
const GHST: Address = "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7";
const QUICK: Address = "0xb5c064f955d8e7f38fe0460c556a72987494ee17";
const TEL: Address = "0xdf7836e3278cdcaf450c33a9254848982424b6e5";
const SAND: Address = "0xbbba073c31bf03b8acf7c28ef0738decf41bb5df";
const GRT: Address = "0x5fe2b58c013d7601147dcdd68c143a77499f5531";

// Factory addresses
export const QUICKSWAP_V2_FACTORY: Address = "0x5757371414417b8c6caad45baef941abc7d3ab32";
const SUSHISWAP_V2_FACTORY: Address = "0xc35dadb65012ec5796536bd9864ed8773abc74c4";
const DFYN_V2_FACTORY: Address = "0xe7fb3e833efe5f9c441105eb65ef8b261266423b";
export const APESWAP_V2_FACTORY: Address = "0xcf083be4164828f00cae704ec15a36d711491284";
const MESHSWAP_V2_FACTORY: Address = "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d";
const JETSWAP_V2_FACTORY: Address = "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7";
const COMETHSWAP_V2_FACTORY: Address = "0x800b052609c355ca8103e06f022aa30647ead60a";
const UNISWAP_V2_FACTORY: Address = "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c";

const UNISWAP_V3_FACTORY: Address = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
const SUSHISWAP_V3_FACTORY: Address = "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2";
const QUICKSWAP_V3_FACTORY: Address = "0x411b0facc3489691f28ad58c47006af5e3ab3a28";
/** QuickSwap V4 Algebra on Polygon — new factory with plugin/hooks support. */
export const QUICKSWAP_V4_FACTORY: Address = "0x134c1dbe4860a9caaf89002574ffe814772d9904";
const KYBERSWAP_ELASTIC_FACTORY: Address = "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a";
/** KyberSwap Elastic factory — canonical cross-chain deployment (same address on all chains). */
const KYBERSWAP_ELASTIC_OFFICIAL_FACTORY: Address = "0xc7a590291e07b9fe9e64b86c58fd8fc764308c4a";
/** Ramses V3 CL factory on Polygon (PoolCreated matches Uniswap V3 layout). */
const RAMSES_V3_FACTORY: Address = "0x2bef16a0081565e72100d73cbe19b1bd2d802380";

/** Uniswap V4 PoolManager on Polygon (canonical deployment). */
const UNISWAP_V4_POOL_MANAGER: Address = "0x67366782805870060151383f4bbff9dab53e5cd6";

// Balancer
export const BALANCER_VAULT: Address = "0xba12222222228d8ba445958a75a0704d566bf2c8";

// DODO V2 (Polygon factory addresses from https://docs.dodoex.io/en/developer/contracts/dodo-v1-v2/contracts-address/polygon)
const DODO_DVM_FACTORY: Address = "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13";
const DODO_DPP_FACTORY: Address = "0xd24153244066f0afa9415563bfc7ba248bfb7a51";
const DODO_DSP_FACTORY: Address = "0x43c49f8dd240e1545f147211ec9f917376ac1e87";

// WOOFi V2 (Polygon) — https://learn.woo.org/woofi-docs/woofi-dev-docs/references/readme/polygon-pos
export const WOOFI_PP_V2: Address = "0x5520385bfcf07ec87c4c53a7d8d65595dff69fa4";
export const WOOFI_PP_V2_DEPLOY_BLOCK = 30_000_000;

// Curve (Polygon) — MetaRegistry aggregates all pools (legacy + NG) via pool_list/pool_count.
// This is NOT the legacy registry. Source: https://github.com/curvefi/docs (deployments.json).
// Deploy block ~58_597_033 (2024-08 NG migration).
export const CURVE_REGISTRY_LEGACY: Address = "0x296d2b5c23833a70d07c8fcbb97d846c1ff90ddd";
const CURVE_REGISTRY_DEPLOY_BLOCK = 58_597_033;

// Curve NG factory addresses (Polygon) — emit TwocryptoPoolDeployed/TricryptoPoolDeployed.
// Source: https://github.com/curvefi/docs (deployments.json).
export const CURVE_TWOCRYPTO_FACTORY: Address = "0x98EE851a00abeE0d95D08cF4CA2BdCE32aeaAF7F";
export const CURVE_TRICRYPTO_FACTORY: Address = "0xC1b393EfEF38140662b91441C6710Aa704973228";

export const POLYGON_CHAIN_ID = 137;

/** Start block from env; 0 when unset (Envio defaults to 0 = from genesis). */
export const chainStart = (() => {
  const v = process.env.POLYGON_START_BLOCK || process.env.ENVIO_POLYGON_START_BLOCK;
  const n = v ? Number(v) : 0;
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
export const DEFAULT_CURVE_N_COINS = 2;

/**
 * Major high-liquidity tokens on the network.
 * Used as "bases" for rate propagation and prioritizing pool discovery.
 */
const RATE_PRECISION = 10n ** 18n;
export const MAJOR_TOKEN_DATA = {
  WMATIC: { address: WMATIC, decimals: 18, approxWholeMaticWei: RATE_PRECISION },
  WETH: { address: WETH, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 1000n },
  USDC: { address: USDC, decimals: 6, approxWholeMaticWei: RATE_PRECISION * 2n },
  USDC_E: { address: USDC_E, decimals: 6, approxWholeMaticWei: RATE_PRECISION * 2n },
  USDT: { address: USDT, decimals: 6, approxWholeMaticWei: RATE_PRECISION * 2n },
  DAI: { address: DAI, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 2n },
  WBTC: { address: WBTC, decimals: 8, approxWholeMaticWei: RATE_PRECISION * 30000n },
  LINK: { address: LINK, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 5n },
  AAVE: { address: AAVE, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 50n },
  CRV: { address: CRV, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 2n },
  BAL: { address: BAL, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 3n },
  UNI: { address: UNI, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 5n },
  GHST: { address: GHST, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 3n },
  QUICK: { address: QUICK, decimals: 18, approxWholeMaticWei: RATE_PRECISION * 100n },
  TEL: { address: TEL, decimals: 2, approxWholeMaticWei: RATE_PRECISION / 100n },
  SAND: { address: SAND, decimals: 18, approxWholeMaticWei: RATE_PRECISION / 2n },
  GRT: { address: GRT, decimals: 18, approxWholeMaticWei: RATE_PRECISION / 4n },
} as const;

/** Set of lowercased major token addresses for fast lookup */
export const MAJOR_TOKENS = new Set(Object.values(MAJOR_TOKEN_DATA).map((t) => t.address.toLowerCase()));

export const KNOWN_FACTORIES_SET = new Set(
  [
    QUICKSWAP_V2_FACTORY,
    SUSHISWAP_V2_FACTORY,
    UNISWAP_V2_FACTORY,
    DFYN_V2_FACTORY,
    APESWAP_V2_FACTORY,
    MESHSWAP_V2_FACTORY,
    JETSWAP_V2_FACTORY,
    COMETHSWAP_V2_FACTORY,
    UNISWAP_V3_FACTORY,
    SUSHISWAP_V3_FACTORY,
    QUICKSWAP_V3_FACTORY,
    QUICKSWAP_V4_FACTORY,
    KYBERSWAP_ELASTIC_FACTORY,
    KYBERSWAP_ELASTIC_OFFICIAL_FACTORY,
    RAMSES_V3_FACTORY,
    UNISWAP_V4_POOL_MANAGER,
    DODO_DVM_FACTORY,
    DODO_DPP_FACTORY,
    DODO_DSP_FACTORY,
    CURVE_REGISTRY_LEGACY,
  ].map((a) => a.toLowerCase()),
);

/** V2 factory address → protocol label and default swap fee (bps). Keys are lowercase. */
export const V2_FACTORY_PROTOCOLS: Record<string, { protocol: string; feeBps: number }> = {
  [QUICKSWAP_V2_FACTORY]: { protocol: "QUICKSWAP_V2", feeBps: 30 },
  [SUSHISWAP_V2_FACTORY]: { protocol: "SUSHISWAP_V2", feeBps: 25 },
  [UNISWAP_V2_FACTORY]: { protocol: "UNISWAP_V2", feeBps: 30 },
  [DFYN_V2_FACTORY]: { protocol: "DFYN_V2", feeBps: 30 },
  [APESWAP_V2_FACTORY]: { protocol: "APESWAP_V2", feeBps: 20 },
  [MESHSWAP_V2_FACTORY]: { protocol: "MESHSWAP_V2", feeBps: 30 },
  [JETSWAP_V2_FACTORY]: { protocol: "JETSWAP_V2", feeBps: 20 },
  [COMETHSWAP_V2_FACTORY]: { protocol: "COMETHSWAP_V2", feeBps: 30 },
};

/** V3 factory address → protocol label. Keys are lowercase. */
export const V3_FACTORY_PROTOCOLS: Record<string, string> = {
  [UNISWAP_V3_FACTORY]: "UNISWAP_V3",
  [SUSHISWAP_V3_FACTORY]: "SUSHISWAP_V3",
  [KYBERSWAP_ELASTIC_FACTORY]: "KYBERSWAP_ELASTIC",
  [KYBERSWAP_ELASTIC_OFFICIAL_FACTORY]: "KYBERSWAP_ELASTIC",
  [RAMSES_V3_FACTORY]: "RAMSES_V3",
};

/** Algebra factory address → protocol label. Keys are lowercase. */
export const ALGEBRA_FACTORY_PROTOCOLS: Record<string, string> = {
  [QUICKSWAP_V3_FACTORY]: "QUICKSWAP_V3",
  [QUICKSWAP_V4_FACTORY]: "QUICKSWAP_V4",
};

export function lookupV2FactoryProtocol(
  factoryAddr: string,
): { protocol: string; feeBps: number } | undefined {
  return V2_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()];
}

export function lookupV3FactoryProtocol(factoryAddr: string): string | undefined {
  return V3_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()];
}

// ── Curve MetaRegistry bootstrap ────────────────────────────────────────

const CURVE_BOOTSTRAP_LEGACY_ID = "137-metaregistry";

export const CURVE_REGISTRY_SOURCES = [
  { id: CURVE_BOOTSTRAP_LEGACY_ID, address: CURVE_REGISTRY_LEGACY, deployBlock: CURVE_REGISTRY_DEPLOY_BLOCK },
] as const;
