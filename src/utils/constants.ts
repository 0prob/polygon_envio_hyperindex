/**
 * Centralized constants for the arbitrage bot and indexer.
 * Source of truth for this repo: src/utils/constants.ts
 */

export type Address = `0x${string}`;

export const RATE_PRECISION = 10n ** 18n;
export const BPS_DENOM = 10000n;
/** Number form of BPS_DENOM for JS bounds checks (slippage caps, fee validation). */
export const BPS_DENOMINATOR = Number(BPS_DENOM);

/**
 * Convert a whole-token MATIC valuation (N * RATE_PRECISION = N MATIC wei per 1.0 token)
 * into the per-smallest-unit rate used by computeMaticRates / tokensToMaticWei.
 */
export function bootstrapMaticRatePerUnit(wholeTokenMaticWei: bigint, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) return wholeTokenMaticWei;
  const scale = 10n ** BigInt(decimals);
  return (wholeTokenMaticWei * RATE_PRECISION) / scale;
}

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

/** Polygon native MATIC sentinel used by some oracles/indexers (not an ERC-20). */
export const NATIVE_MATIC: Address = "0x0000000000000000000000000000000000001010";

/** Polygon canonical addresses. All lowercase. */

// Token addresses
export const WMATIC: Address = "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270";
export const WETH: Address = "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619";
/** Native USDC (Circle) */
export const USDC: Address = "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359";
export const USDC_NATIVE = USDC;
/** Bridged USDC (USDC.e / PoS) */
export const USDC_E: Address = "0x2791bca1f2de4661ed88a30c99a7a9449aa84174";
export const USDT: Address = "0xc2132d05d31c914a87c6611c10748aeb04b58e8f";
export const DAI: Address = "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063";
export const WBTC: Address = "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6";
export const LINK: Address = "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39";
export const AAVE: Address = "0xd6df932a45c0f255f85145f286ea0b292b21c90b";
export const CRV: Address = "0x172370d5cd63279efa6d502dab29171933a610af";
export const BAL: Address = "0x9a71012b13ca4d3d0cdcbc8942ec6c4e9e0e6c8c";
export const UNI: Address = "0xb33eaad8d922b1083446dc23f610c2567fb5180f";
export const GHST: Address = "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7";
export const QUICK: Address = "0xb5c064f955d8e7f38fe0460c556a72987494ee17";
export const TEL: Address = "0xdf7836e3278cdcaf450c33a9254848982424b6e5";
export const SAND: Address = "0xbbba073c31bf03b8acf7c28ef0738decf41bb5df";
export const GRT: Address = "0x5fe2b58c013d7601147dcdd68c143a77499f5531";

// Factory addresses
export const QUICKSWAP_V2_FACTORY: Address = "0x5757371414417b8c6caad45baef941abc7d3ab32";
export const SUSHISWAP_V2_FACTORY: Address = "0xc35dadb65012ec5796536bd9864ed8773abc74c4";
export const DFYN_V2_FACTORY: Address = "0xe7fb3e833efe5f9c441105eb65ef8b261266423b";
export const APESWAP_V2_FACTORY: Address = "0xcf083be4164828f00cae704ec15a36d711491284";
export const MESHSWAP_V2_FACTORY: Address = "0x9f3044f7f9fc8bc9ed615d54845b4577b833282d";
export const JETSWAP_V2_FACTORY: Address = "0x668ad0ed2622c62e24f0d5ab6b6ac1b9d2cd4ac7";
export const COMETHSWAP_V2_FACTORY: Address = "0x800b052609c355ca8103e06f022aa30647ead60a";
export const UNISWAP_V2_FACTORY: Address = "0x9e5a52f57b3038f1b8eee45f28b3c1967e22799c";

export const UNISWAP_V3_FACTORY: Address = "0x1f98431c8ad98523631ae4a59f267346ea31f984";
export const SUSHISWAP_V3_FACTORY: Address = "0x917933899c6a5f8e37f31e19f92cdbff7e8ff0e2";
export const QUICKSWAP_V3_FACTORY: Address = "0x411b0facc3489691f28ad58c47006af5e3ab3a28";
export const KYBERSWAP_ELASTIC_FACTORY: Address = "0x5f1dddbf348ac2fbe22a163e30f99f9ece3dd50a";
/** Ramses V3 CL factory on Polygon (PoolCreated matches Uniswap V3 layout). */
export const RAMSES_V3_FACTORY: Address = "0x2bef16a0081565e72100d73cbe19b1bd2d802380";
/** Factory Initialize tx on Polygon (~2026-01-27). */
export const RAMSES_V3_FACTORY_START_BLOCK = 82_177_772;

/** Uniswap V4 PoolManager on Polygon (canonical deployment). */
export const UNISWAP_V4_POOL_MANAGER: Address = "0x67366782805870060151383f4bbff9dab53e5cd6";
/** First Initialize event on Polygon (~67082470). */
export const UNISWAP_V4_POOL_MANAGER_START_BLOCK = 67_082_470;

// Balancer
export const BALANCER_VAULT: Address = "0xba12222222228d8ba445958a75a0704d566bf2c8";
export const BALANCER_VAULT_START_BLOCK = 15_832_990;

// DODO V2 (Polygon factory addresses from https://docs.dodoex.io/en/developer/contracts/dodo-v1-v2/contracts-address/polygon)
export const DODO_DVM_FACTORY: Address = "0x79887f65f83bdf15bcc8736b5e5bcdb48fb8fe13";
export const DODO_DPP_FACTORY: Address = "0xd24153244066f0afa9415563bfc7ba248bfb7a51";
export const DODO_DSP_FACTORY: Address = "0x43c49f8dd240e1545f147211ec9f917376ac1e87";
export const DODO_FACTORY_START_BLOCK = 14_722_979;

// WOOFi V2 (Polygon) — https://learn.woo.org/woofi-docs/woofi-dev-docs/references/readme/polygon-pos
export const WOOFI_PP_V2: Address = "0x5520385bfcf07ec87c4c53a7d8d65595dff69fa4";
export const WOOFI_ROUTER_V2: Address = "0x4c4af8dbc524681930a27b2f1af5bcc8062e6fb7";
export const WOOFI_PP_V2_DEPLOY_BLOCK = 30_000_000;

// Curve (Polygon) — registry redeployed ~block 58_597_033 (2024-08).
// AddressProviderNG (0x5ffe7FB8…) get_address(7) resolves to the same contract on Polygon.
export const CURVE_REGISTRY_LEGACY: Address = "0x296d2b5c23833a70d07c8fcbb97d846c1ff90ddd";
export const CURVE_REGISTRY_DEPLOY_BLOCK = 58_597_033;

// Aave V3 Polygon
export const AAVE_V3_POOL: Address = "0x794a61358d6845594f94dc1db02a252b5b4814ad";
export const AAVE_V3_POOL_ADDRESSES_PROVIDER: Address = "0xa97684ead0e402dc232d5a977953df7ecbab3cdb";

// Chainlink MATIC/USD feed
export const CHAINLINK_MATIC_USD: Address = "0xab594600376ec9fd91f8e885dadf0ce036862de0";

// Multicall3
export const MULTICALL3: Address = "0xca11bde05977b3631167028862be2a173976ca11";

/**
 * Major high-liquidity tokens on the network.
 * Used as "bases" for rate propagation and prioritizing pool discovery.
 */
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

/** Map of major token addresses to their approximate MATIC rates for bootstrapping */
export const MAJOR_TOKEN_APPROX_RATES = new Map<string, bigint>(
  Object.values(MAJOR_TOKEN_DATA).map((t) => [
    t.address.toLowerCase(),
    bootstrapMaticRatePerUnit(t.approxWholeMaticWei, t.decimals),
  ]),
);

export const KNOWN_FACTORIES = [
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
  KYBERSWAP_ELASTIC_FACTORY,
  RAMSES_V3_FACTORY,
  UNISWAP_V4_POOL_MANAGER,
  DODO_DVM_FACTORY,
  DODO_DPP_FACTORY,
  DODO_DSP_FACTORY,
  CURVE_REGISTRY_LEGACY,
];

export const KNOWN_FACTORIES_SET = new Set(KNOWN_FACTORIES.map((a) => a.toLowerCase()));

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

/** Polygon deployment blocks (Polygonscan contract-creation txs). Used by config.yaml start_block defaults. */
export const V2_FACTORY_START_BLOCKS: Record<string, number> = {
  [QUICKSWAP_V2_FACTORY]: 4_931_780,
  [SUSHISWAP_V2_FACTORY]: 11_333_218,
  [UNISWAP_V2_FACTORY]: 49_948_178,
  [DFYN_V2_FACTORY]: 5_436_831,
  [APESWAP_V2_FACTORY]: 15_298_801,
  [MESHSWAP_V2_FACTORY]: 27_827_673,
  [JETSWAP_V2_FACTORY]: 16_569_374,
  [COMETHSWAP_V2_FACTORY]: 11_633_169,
};

/** V3 factory address → protocol label. Keys are lowercase. */
export const V3_FACTORY_PROTOCOLS: Record<string, string> = {
  [UNISWAP_V3_FACTORY]: "UNISWAP_V3",
  [SUSHISWAP_V3_FACTORY]: "SUSHISWAP_V3",
  [KYBERSWAP_ELASTIC_FACTORY]: "KYBERSWAP_ELASTIC",
  [RAMSES_V3_FACTORY]: "RAMSES_V3",
};

/** Algebra factory address → protocol label (QuickSwap V3 on Polygon). Keys are lowercase. */
export const ALGEBRA_FACTORY_PROTOCOLS: Record<string, string> = {
  [QUICKSWAP_V3_FACTORY]: "QUICKSWAP_V3",
};

/** Polygon deployment blocks for Uniswap-style V3 PoolCreated factories (Polygonscan). */
export const V3_FACTORY_START_BLOCKS: Record<string, number> = {
  [UNISWAP_V3_FACTORY]: 22_757_547,
  [SUSHISWAP_V3_FACTORY]: 44_059_924,
  [KYBERSWAP_ELASTIC_FACTORY]: 29_350_287,
  [RAMSES_V3_FACTORY]: RAMSES_V3_FACTORY_START_BLOCK,
};

/** Polygon deployment blocks for Algebra Pool factories (Polygonscan). */
export const ALGEBRA_FACTORY_START_BLOCKS: Record<string, number> = {
  [QUICKSWAP_V3_FACTORY]: 34_502_463,
};

export const DEFAULT_V2_FACTORY_PROTOCOL = { protocol: "UNKNOWN_V2", feeBps: 30 } as const;
export const DEFAULT_V3_FACTORY_PROTOCOL = "UNKNOWN_V3";
export const DEFAULT_ALGEBRA_FACTORY_PROTOCOL = "UNKNOWN_V3";

export function lookupV2FactoryProtocol(factoryAddr: string): { protocol: string; feeBps: number } {
  return V2_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()] ?? DEFAULT_V2_FACTORY_PROTOCOL;
}

export function lookupV2FactoryStartBlock(factoryAddr: string): number | undefined {
  return V2_FACTORY_START_BLOCKS[factoryAddr.toLowerCase()];
}

export function lookupV3FactoryProtocol(factoryAddr: string): string {
  return V3_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()] ?? DEFAULT_V3_FACTORY_PROTOCOL;
}

export function lookupAlgebraFactoryProtocol(factoryAddr: string): string {
  return ALGEBRA_FACTORY_PROTOCOLS[factoryAddr.toLowerCase()] ?? DEFAULT_ALGEBRA_FACTORY_PROTOCOL;
}

export function lookupV3FactoryStartBlock(factoryAddr: string): number | undefined {
  return V3_FACTORY_START_BLOCKS[factoryAddr.toLowerCase()];
}

export function lookupAlgebraFactoryStartBlock(factoryAddr: string): number | undefined {
  return ALGEBRA_FACTORY_START_BLOCKS[factoryAddr.toLowerCase()];
}

/** All indexed contract addresses → deployment start block (lowercase keys). */
export const INDEXED_CONTRACT_START_BLOCKS: Record<string, number> = {
  ...V2_FACTORY_START_BLOCKS,
  ...V3_FACTORY_START_BLOCKS,
  ...ALGEBRA_FACTORY_START_BLOCKS,
  [UNISWAP_V4_POOL_MANAGER]: UNISWAP_V4_POOL_MANAGER_START_BLOCK,
  [CURVE_REGISTRY_LEGACY]: CURVE_REGISTRY_DEPLOY_BLOCK,
  [BALANCER_VAULT]: BALANCER_VAULT_START_BLOCK,
  [DODO_DVM_FACTORY]: DODO_FACTORY_START_BLOCK,
  [DODO_DPP_FACTORY]: DODO_FACTORY_START_BLOCK,
  [DODO_DSP_FACTORY]: DODO_FACTORY_START_BLOCK,
  [WOOFI_PP_V2]: WOOFI_PP_V2_DEPLOY_BLOCK,
};

export function lookupIndexedContractStartBlock(address: string): number | undefined {
  return INDEXED_CONTRACT_START_BLOCKS[address.toLowerCase()];
}
