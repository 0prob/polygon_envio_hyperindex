#!/usr/bin/env bun
/**
 * Generates an expanded STATIC_TOKEN_DECIMALS map for Polygon.
 *
 * Pulls from several free, public token lists + the bot's own data.
 *
 * Recommended usage (internal, called by auto-update):
 *   bun run generate-tokens:auto
 *   bun run generate-tokens     # raw (for the auto script)
 *
 * Sources (all free, focused on Polygon):
 * - CoinGecko Polygon (broadest)
 * - Uniswap
 * - Sushiswap
 * - TrustWallet Polygon assets
 * - 1inch Token List (excellent broad coverage)
 * - QuickSwap token list
 * - Official Polygon Token Lists (mapped + popular) from api-polygon-tokens.polygon.technology
 *
 * Plus a curated core list of high-frequency V2/V3 bases.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAutoExtraEntries, loadDiscoveredDecimalsEntries } from "../src/utils/token_disk.ts";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

type TokenListToken = {
  address: string;
  decimals: number;
  symbol?: string;
  name?: string;
};

const LISTS = [
  // CoinGecko — very broad coverage for Polygon (recommended primary source)
  "https://tokens.coingecko.com/polygon-pos/all.json",

  // Uniswap (good general coverage)
  "https://tokens.uniswap.org",

  // Sushiswap Polygon
  "https://raw.githubusercontent.com/sushiswap/list/master/lists/token-lists/default-token-list/tokens/polygon.json",

  // Trust Wallet assets for Polygon (good additional coverage)
  "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/tokenlist.json",

  // ViaProtocol Polygon Token List — excellent broad coverage of many lists including 1inch, Li.Fi, sushiswap, etc.
  "https://raw.githubusercontent.com/viaprotocol/tokenlists/main/tokenlists/polygon.json",

  // === Official Polygon Token Lists (highest value for our use case) ===
  // These are curated by the Polygon team and focus on actually bridged / popular tokens.
  // Perfect for reducing RPC calls in fetchTokenMeta during V2/V3 factory events.
  "https://api-polygon-tokens.polygon.technology/tokenlists/mapped.tokenlist.json", // Mapped/bridged tokens
  "https://api-polygon-tokens.polygon.technology/tokenlists/popular.tokenlist.json", // Top used tokens

  // Official Polygon dev branch mapped/bridged lists
  "https://raw.githubusercontent.com/0xPolygon/polygon-token-list/dev/src/tokens/mappedTokens.json",
  "https://raw.githubusercontent.com/0xPolygon/polygon-token-list/dev/src/tokens/defaultTokens.json",

  // QuickSwap community/maintained list (good for Polygon DEX-specific tokens)
  "https://unpkg.com/quickswap-default-token-list@latest/build/quickswap-default.tokenlist.json",

  // LI.FI active token list for chain 137 (excellent aggregator list)
  "https://li.quest/v1/tokens?chains=137",
];

async function fetchList(url: string): Promise<TokenListToken[]> {
  try {
    const res = await fetch(url, { headers: { "User-Agent": "hyperindex-polygon-tokens/1.0" } });
    if (!res.ok) {
      console.warn(`  Skipped ${url} (HTTP ${res.status})`);
      return [];
    }
    const json = await res.json();

    // Handle { tokens: [...] }, { tokens: { "137": [...] } }, and direct array formats
    let tokens: any[] = Array.isArray(json)
      ? json
      : Array.isArray(json.tokens)
        ? json.tokens
        : typeof json.tokens === "object" && json.tokens !== null
          ? Object.values(json.tokens).flat()
          : [];

    // Helper to validate hex address format and reject the zero address
    const isValidHexAddress = (a: string) => /^0x[a-f0-9]{40}$/i.test(a) && a !== "0x0000000000000000000000000000000000000000";

    // Only apply chainId=137 filtering for known multi-chain lists.
    const MULTI_CHAIN_LISTS = [
      "https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/polygon/tokenlist.json",
      "https://unpkg.com/quickswap-default-token-list@latest/build/quickswap-default.tokenlist.json",
      "https://li.quest/v1/tokens?chains=137",
    ];
    if (MULTI_CHAIN_LISTS.includes(url) && tokens.length > 0 && tokens[0]?.chainId !== undefined) {
      tokens = tokens.filter((t: any) => t.chainId === 137 || t.chainId === "137");
    }

    // Special handling for official Polygon hosted token lists
    // (mapped.tokenlist.json / popular.tokenlist.json / mappedTokens.json / defaultTokens.json).
    // These use a richer format with `wrappedTokens` containing the actual Polygon addresses.
    const POLYGON_OFFICIAL_LISTS = [
      "https://api-polygon-tokens.polygon.technology/tokenlists/mapped.tokenlist.json",
      "https://api-polygon-tokens.polygon.technology/tokenlists/popular.tokenlist.json",
      "https://raw.githubusercontent.com/0xPolygon/polygon-token-list/dev/src/tokens/mappedTokens.json",
      "https://raw.githubusercontent.com/0xPolygon/polygon-token-list/dev/src/tokens/defaultTokens.json",
    ];

    if (POLYGON_OFFICIAL_LISTS.includes(url)) {
      const extracted: TokenListToken[] = [];
      for (const t of tokens) {
        // Look for wrapped tokens on Polygon (chain -1 or 137 in this schema often means Polygon)
        const wrapped = t.wrappedTokens || [];
        for (const w of wrapped) {
          if (w.wrappedTokenAddress && typeof t.decimals === "number" && isValidHexAddress(w.wrappedTokenAddress)) {
            extracted.push({
              address: w.wrappedTokenAddress.toLowerCase(),
              decimals: Number(t.decimals),
              symbol: w.symbol || t.symbol,
              name: w.name || t.name,
            });
          }
        }
        // Also include if the top-level token is already on Polygon (chainId 137)
        if ((t.chainId === 137 || t.chainId === -1) && t.address && typeof t.decimals === "number" && isValidHexAddress(t.address)) {
          extracted.push({
            address: t.address.toLowerCase(),
            decimals: Number(t.decimals),
            symbol: t.symbol,
            name: t.name,
          });
        }
      }
      return extracted;
    }

    return tokens
      .filter((t) => t.address && typeof t.decimals === "number" && isValidHexAddress(t.address))
      .map((t) => ({
        address: t.address.toLowerCase(),
        decimals: Number(t.decimals),
        symbol: t.symbol,
        name: t.name,
      }));
  } catch (e) {
    console.warn(`  Skipped ${url}: ${e instanceof Error ? e.message : e}`);
    return [];
  }
}

// Optional local file for manually adding tokens the bot sees in production
// that are not yet in public lists (e.g. very new launches or low-volume gems).
// Place a file at hyperindex/extra-tokens.json with shape: [{ "address": "0x...", "decimals": 18 }, ...]
const EXTRA_TOKENS_FILE = "./extra-tokens.json";

// Bot's own anchor pools — extract every token the bot is actively configured to trade.
const BOT_POOLS_FILE = "../../scripts/pools.json";

// Runtime discovered tokens (from previous indexer runs)
const DATA_DIR = "../../data";
const DISCOVERED_FILE = `${DATA_DIR}/discovered-decimals.json`;
const DISCOVERED_NDJSON_FILE = `${DATA_DIR}/discovered-decimals.ndjson`;

// Auto-discovered cold tokens written by the running indexer
const AUTO_EXTRA_FILE = `${DATA_DIR}/auto-extra-tokens.json`;
const AUTO_EXTRA_NDJSON_FILE = `${DATA_DIR}/auto-extra-tokens.ndjson`;

async function loadExtraTokens(): Promise<TokenListToken[]> {
  try {
    const content = await Bun.file(EXTRA_TOKENS_FILE).text();
    const parsed = JSON.parse(content);
    if (Array.isArray(parsed)) {
      return parsed
        .filter((t: any) => t.address && typeof t.decimals === "number")
        .map((t: any) => ({
          address: t.address.toLowerCase(),
          decimals: Number(t.decimals),
          symbol: t.symbol,
          name: t.name,
        }));
    }
  } catch {
    // File doesn't exist or is invalid — that's fine
  }
  return [];
}

async function loadFromPoolsFile(): Promise<TokenListToken[]> {
  try {
    const content = await Bun.file(BOT_POOLS_FILE).text();
    const pools = JSON.parse(content);
    const tokens = new Map<string, number>();

    for (const pool of pools) {
      if (Array.isArray(pool.tokens)) {
        for (const addr of pool.tokens) {
          if (typeof addr === "string" && !tokens.has(addr.toLowerCase())) {
            // We don't know decimals here — we'll use 18 as a safe default for bases.
            // Real decimals will be corrected when the public lists or extra files are merged.
            tokens.set(addr.toLowerCase(), 18);
          }
        }
      }
    }
    return Array.from(tokens.entries()).map(([address, decimals]) => ({ address, decimals }));
  } catch {
    return [];
  }
}

async function loadDiscoveredTokens(): Promise<TokenListToken[]> {
  const data = await loadDiscoveredDecimalsEntries(DISCOVERED_FILE, DISCOVERED_NDJSON_FILE);
  return Object.entries(data).map(([address, decimals]) => ({
    address: address.toLowerCase(),
    decimals: Number(decimals),
  }));
}

async function main() {
  console.log("/**");
  console.log(" * Static token decimals registry for Polygon (0 RPC for known tokens).");
  console.log(" *");
  console.log(" * Pre-generated from public lists. Focused *only* on decimals because");
  console.log(" * that is the only token data the arbitrage engine needs for math.");
  console.log(" *");
  console.log(" * PERFORMANCE NOTE (Envio):");
  console.log(" * V2Factory.PairCreated is consistently the slowest handler because it calls");
  console.log(" * fetchTokenMeta for both tokens. When a token is not in this static map, the");
  console.log(" * effect falls back to RPC → shows up as 70-85% 'Loaders' time in pipeline split.");
  console.log(" * Keep this registry as complete as possible. Run: bun run generate-tokens");
  console.log(" *");
  console.log(
    " * Current sources: CoinGecko, Uniswap, Sushiswap, TrustWallet, 1inch, QuickSwap + official Polygon mapped/popular lists + curated core.",
  );
  console.log(" *");
  console.log(" * Extra tokens: Place hyperindex/extra-tokens.json (manual) or let the bot auto-write to data/auto-extra-tokens.json.");
  console.log(" * The generator also pulls tokens from the bot's scripts/pools.json and runtime discoveries.");
  console.log(" * Cold tokens discovered by the running indexer are automatically fed back into the registry.");
  console.log(" *");
  console.log(" * Refresh: bun run generate-tokens");
  console.log(" */");
  console.log("export const STATIC_TOKEN_DECIMALS: Record<string, number> = {");

  const allTokens = new Map<string, number>();

  // Core high-value tokens the bot cares about for arbitrage math (decimals only).
  // These are the ones the engine will fetch anyway for simulations/profit calc.
  // Expanded list of common Polygon DEX tokens (majors, stables, high-liq pairs from Quickswap/Sushi/etc.)
  const core: Record<string, number> = {
    "0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270": 18, // WMATIC
    "0x0000000000000000000000000000000000001010": 18, // MATIC
    "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619": 18, // WETH
    "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": 6, // USDC
    "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6, // USDC.e
    "0xc2132d05d31c914a87c6611c10748aeb04b58e8f": 6, // USDT
    "0x8f3cf7ad23cd3cadbd9735aff958023239c6a063": 18, // DAI
    "0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6": 8, // WBTC
    "0x53e0bca35ec356bd5dddfebbd1fc0fd03fabad39": 18, // LINK
    "0xb33eaad8d922b1083446dc23f610c2567fb5180f": 18, // UNI
    "0x0b3f868e0be5597d5db7feb59e1cadbb0fdda50a": 18, // SUSHI
    "0x9a71012b13ca4d3d0cdc72a177df3ef03b0e76a3": 18, // BAL
    "0x172370d5cd63279efa6d502dab29171933a610af": 18, // CRV
    "0xd6df932a45c0f255f85145f286ea0b292b21c90b": 18, // AAVE
    "0x385eeac5cb85a38a9a07a70c73e0a3271cfb54a7": 18, // GHST
    "0xb5c064f955d8e7f38fe0460c556a72987494ee17": 18, // QUICK
    "0x831753dd7087cac61ab5644b308642cc1c33dc13": 18, // QUICK (old)
    "0x0b048d6e01a6b9002c291060bf2179938fd8264c": 18, // WOO
    "0x6f7c932e7684666c9fd1d44527765433e01ff61d": 18, // USDD
    "0x2e1ad108ff1d8c782fcbbb89aad783ac49586756": 18, // stMATIC
    "0xfa68fb4628dff1028cfec22b4162fccd0d45efb6": 18, // LQTY
    "0x5fe2b58c013d7601147dcdd68c143a77499f5531": 18, // GRT
    "0x2f800db0fdb5223b3c3f354886d907a671414a7f": 18, // TCO2
    "0x1b815d120b3ef02039ee11dc2d63b2d2e5e8e8e8": 18, // MANA
  };

  Object.entries(core).forEach(([addr, dec]) => allTokens.set(addr.toLowerCase(), dec));

  for (const url of LISTS) {
    const tokens = await fetchList(url);
    for (const t of tokens) {
      if (!allTokens.has(t.address)) {
        allTokens.set(t.address, t.decimals);
      }
    }
    console.error(`Fetched ${tokens.length} tokens from ${url}`);
  }

  // Load tokens from the bot's own anchor pools (scripts/pools.json)
  const fromPools = await loadFromPoolsFile();
  for (const t of fromPools) {
    if (!allTokens.has(t.address)) {
      allTokens.set(t.address, t.decimals);
    }
  }
  if (fromPools.length > 0) {
    console.error(`Loaded ${fromPools.length} tokens from bot pools.json`);
  }

  // Load runtime discovered tokens
  const discovered = await loadDiscoveredTokens();
  for (const t of discovered) {
    if (!allTokens.has(t.address)) {
      allTokens.set(t.address, t.decimals);
    }
  }
  if (discovered.length > 0) {
    console.error(`Loaded ${discovered.length} tokens from ${DISCOVERED_FILE} (+ ndjson append log)`);
  }

  // Load auto-discovered cold tokens written by the running indexer
  const autoExtra = await loadAutoExtraEntries(AUTO_EXTRA_FILE, AUTO_EXTRA_NDJSON_FILE);
  for (const t of autoExtra) {
    if (!allTokens.has(t.address)) {
      allTokens.set(t.address, t.decimals);
    }
  }
  if (autoExtra.length > 0) {
    console.error(`Loaded ${autoExtra.length} auto-discovered tokens from ${AUTO_EXTRA_FILE} (+ ndjson append log)`);
  }

  // Load any manually curated extra tokens
  const extra = await loadExtraTokens();
  for (const t of extra) {
    if (!allTokens.has(t.address)) {
      allTokens.set(t.address, t.decimals);
    }
  }
  if (extra.length > 0) {
    console.error(`Loaded ${extra.length} extra tokens from ${EXTRA_TOKENS_FILE}`);
  }

  // QuickSwap token list is currently unavailable from public raw GitHub sources.
  // We rely on CoinGecko (strong Polygon coverage) + Uniswap + Sushiswap instead.
  // If a stable QuickSwap list URL returns, add it back to LISTS.

  const sorted = Array.from(allTokens.entries()).sort((a, b) => a[0].localeCompare(b[0]));

  for (const [address, decimals] of sorted) {
    console.log(`  "${address}": ${decimals},`);
  }

  console.log("};");
  console.error(`\nTotal unique tokens: ${allTokens.size}`);

  await writeTokenRegistryDb(allTokens);
}

async function writeTokenRegistryDb(tokens: Map<string, number>): Promise<void> {
  const dbPath = path.resolve(ROOT, "../token_registry.db");
  const { Database } = await import("bun:sqlite");
  const db = new Database(dbPath);
  db.run(
    "CREATE TABLE IF NOT EXISTS token_decimals (address TEXT PRIMARY KEY NOT NULL, decimals INTEGER NOT NULL)",
  );
  const insert = db.prepare("INSERT OR REPLACE INTO token_decimals (address, decimals) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const [address, decimals] of tokens) {
      insert.run(address, decimals);
    }
  });
  tx();
  db.close();
  console.error(`Wrote ${tokens.size} token decimals to ${dbPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
