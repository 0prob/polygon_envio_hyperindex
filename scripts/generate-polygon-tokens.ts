#!/usr/bin/env bun
/**
 * Rebuild `data/token_registry.db` from workspace-local sources only (no network fetch).
 *
 * Merge order (later wins):
 *   1. Existing data/token_registry.db (if present)
 *   2. Hardcoded Polygon core tokens
 *   3. data/pools.json (decimals=18 placeholder when unknown)
 *   4. data/discovered-decimals.ndjson (RPC-verified at indexer runtime)
 *   5. data/extra-tokens.json (manual overrides)
 *
 * Usage:
 *   bun run generate-tokens
 *   bun run generate-tokens:auto
 */
import {
  DISCOVERED_DECIMALS_NDJSON,
  EXTRA_TOKENS_JSON,
  POOLS_JSON,
  TOKEN_REGISTRY_DB,
} from "../src/utils/data_paths.ts";
import { loadDiscoveredDecimalsEntries } from "../src/utils/token_disk.ts";

type TokenEntry = { address: string; decimals: number };

/** Well-known Polygon tokens — always correct, override db placeholders. */
const CORE_TOKENS: Record<string, number> = {
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

async function loadExistingDb(): Promise<Map<string, number>> {
  const tokens = new Map<string, number>();
  try {
    const { Database } = await import("bun:sqlite");
    const db = new Database(TOKEN_REGISTRY_DB, { readonly: true });
    const rows = db
      .prepare("SELECT address, decimals FROM token_decimals")
      .all() as { address: string; decimals: number }[];
    db.close();
    for (const row of rows) {
      tokens.set(row.address.toLowerCase(), row.decimals);
    }
    console.error(`Loaded ${tokens.size} tokens from existing ${TOKEN_REGISTRY_DB}`);
  } catch {
    console.error(`No existing ${TOKEN_REGISTRY_DB} — starting fresh (core + local overlays only)`);
  }
  return tokens;
}

async function loadExtraTokens(): Promise<TokenEntry[]> {
  try {
    const content = await Bun.file(EXTRA_TOKENS_JSON).text();
    const parsed = JSON.parse(content);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((t: { address?: string; decimals?: number }) => t.address && typeof t.decimals === "number")
      .map((t: { address: string; decimals: number }) => ({
        address: t.address.toLowerCase(),
        decimals: Number(t.decimals),
      }));
  } catch {
    return [];
  }
}

async function loadFromPoolsFile(): Promise<TokenEntry[]> {
  try {
    const content = await Bun.file(POOLS_JSON).text();
    const pools = JSON.parse(content);
    const tokens = new Map<string, number>();
    for (const pool of pools) {
      if (!Array.isArray(pool.tokens)) continue;
      for (const addr of pool.tokens) {
        if (typeof addr !== "string") continue;
        const key = addr.toLowerCase();
        if (!tokens.has(key)) tokens.set(key, 18);
      }
    }
    return [...tokens.entries()].map(([address, decimals]) => ({ address, decimals }));
  } catch {
    return [];
  }
}

async function loadDiscoveredNdjson(): Promise<TokenEntry[]> {
  const data = await loadDiscoveredDecimalsEntries(null, DISCOVERED_DECIMALS_NDJSON);
  return Object.entries(data).map(([address, decimals]) => ({
    address: address.toLowerCase(),
    decimals: Number(decimals),
  }));
}

function mergeTokens(base: Map<string, number>, entries: TokenEntry[], label: string): void {
  let added = 0;
  let updated = 0;
  for (const { address, decimals } of entries) {
    if (!base.has(address)) added++;
    else if (base.get(address) !== decimals) updated++;
    base.set(address, decimals);
  }
  if (entries.length > 0) {
    console.error(`Merged ${entries.length} from ${label} (+${added} new, ~${updated} updated)`);
  }
}

async function main() {
  const autoRun = process.env.npm_lifecycle_event === "generate-tokens:auto";
  if (autoRun) {
    console.log("🔄 Rebuilding data/token_registry.db (local sources only)...\n");
  }

  const allTokens = await loadExistingDb();

  mergeTokens(
    allTokens,
    Object.entries(CORE_TOKENS).map(([address, decimals]) => ({ address, decimals })),
    "core tokens",
  );

  mergeTokens(allTokens, await loadFromPoolsFile(), POOLS_JSON);
  mergeTokens(allTokens, await loadDiscoveredNdjson(), DISCOVERED_DECIMALS_NDJSON);
  mergeTokens(allTokens, await loadExtraTokens(), EXTRA_TOKENS_JSON);

  if (allTokens.size === 0) {
    console.error(
      "❌ No token sources found. Need an existing token_registry.db or local data files under data/.",
    );
    process.exit(1);
  }

  await writeTokenRegistryDb(allTokens);
  console.error(`\nTotal unique tokens: ${allTokens.size}`);
  if (autoRun) {
    console.log("\n✅ data/token_registry.db updated.");
  }
}

async function writeTokenRegistryDb(tokens: Map<string, number>): Promise<void> {
  const dbPath = TOKEN_REGISTRY_DB;
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
