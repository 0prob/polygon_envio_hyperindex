import { createEffect, S } from "envio";
import {
  BaseError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  parseAbi,
} from "viem";
import { publicClient } from "./rpc_client";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DAI, USDC, USDC_E, USDT, WBTC, WETH, WMATIC } from "../utils/constants";
import { getTokenMetaEffectRateLimit } from "../utils/pacing";
import {
  appendAutoExtraEntry,
  appendDiscoveredDecimals,
  appendFailedTokens,
  loadAutoExtraEntries,
  loadDiscoveredDecimalsEntries,
  loadFailedTokenEntries,
} from "../utils/token_disk";
import { safeDecimals } from "../utils/safe_decimals";
import { isNetworkError, isQuotaError } from "../utils/rpc_errors";
import { normalizeTokenAddress } from "../utils/normalize_address";

// Bun: import.meta.dir — Node (Envio/tsx): import.meta.dirname
const ROOT =
  import.meta.dir ??
  import.meta.dirname ??
  path.dirname(fileURLToPath(import.meta.url));

/** Project root (`src/effects` → `../..`). */
const PROJECT_ROOT = path.resolve(ROOT, "../..");

let db: any = null;

/** Well-known Polygon tokens used by handler tests — avoids RPC when Vitest runs without bun:sqlite. */
const VITEST_TOKEN_DECIMALS: Record<string, number> = {
  [WMATIC]: 18,
  [WETH]: 18,
  [USDC_E]: 6,
  [USDT]: 6,
  [USDC]: 6,
  [DAI]: 18,
  [WBTC]: 8,
};

async function initDb() {
  if (db !== null) return;
  const dbPath =
    process.env.TOKEN_REGISTRY_DB?.trim() ||
    path.resolve(PROJECT_ROOT, "token_registry.db");
  let lastError: unknown;

  // Bun runtime (scripts, direct handler runs)
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    return;
  } catch (e) {
    lastError = e;
  }

  // Node 22+ built-in sqlite (Envio indexer runtime)
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    return;
  } catch (e) {
    lastError = e;
  }

  db = undefined;
  if (process.env.VITEST !== "true") {
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    console.warn(
      `[token_metadata] sqlite unavailable, skipping static registry lookup (${detail}; path=${dbPath})`,
    );
  }
}

const DISCOVERED_DECIMALS_FILE = path.resolve(PROJECT_ROOT, "data/discovered-decimals.json");
const DISCOVERED_DECIMALS_NDJSON = path.resolve(PROJECT_ROOT, "data/discovered-decimals.ndjson");
const FAILED_DECIMALS_FILE = path.resolve(PROJECT_ROOT, "data/failed-decimals.json");
const FAILED_DECIMALS_NDJSON = path.resolve(PROJECT_ROOT, "data/failed-decimals.ndjson");
const AUTO_EXTRA_TOKENS_FILE = path.resolve(PROJECT_ROOT, "data/auto-extra-tokens.json");
const AUTO_EXTRA_TOKENS_NDJSON = path.resolve(PROJECT_ROOT, "data/auto-extra-tokens.ndjson");
const PERSIST_FLUSH_DEBOUNCE_MS = 2000;
// No TTL — a contract that isn't ERC20 will never become one. Permanent blocklist.

// Runtime discovered decimals (persisted across restarts for this indexer instance)
const discoveredDecimals: Record<string, number> = {};
const persistedDiscovered = new Set<string>();
let discoveredLoaded = false;
let discoveredDirty = false;
let discoveredFlushTimer: ReturnType<typeof setTimeout> | null = null;
let discoveredSavePending: Promise<void> | null = null;

const registryCache: Map<string, number> = new Map();
let cacheLoaded = false;

const inFlightDecimals = new Map<string, Promise<{ address: string; decimals: number; trusted: boolean }>>();

export type RegistryDecimalsHit = { decimals: number; trusted: true };

/**
 * Batch lookup from static registry + discovered-decimals overlay (0 RPC, 0 effects).
 * Call once per factory event before fetchTokenMeta to avoid effect overhead on known tokens.
 */
export async function lookupRegistryDecimalsBatch(
  addresses: readonly string[],
): Promise<Map<string, RegistryDecimalsHit>> {
  await warmUpCache();
  const out = new Map<string, RegistryDecimalsHit>();
  const seen = new Set<string>();
  for (const raw of addresses) {
    const addr = normalizeTokenAddress(raw);
    if (seen.has(addr)) continue;
    seen.add(addr);
    const decimals = registryCache.get(addr);
    if (decimals !== undefined) {
      out.set(addr, { decimals, trusted: true });
    }
  }
  return out;
}

const PRELOAD_DECIMALS_DEFAULT = { decimals: 18, trusted: false as const };

/** Placeholder for preload when registry + Hasura have no decimals yet. */
export function preloadTokenDecimalsDefault(): { decimals: number; trusted: false } {
  return PRELOAD_DECIMALS_DEFAULT;
}

function seedVitestRegistry(): void {
  for (const [addr, decimals] of Object.entries(VITEST_TOKEN_DECIMALS)) {
    registryCache.set(addr.toLowerCase(), decimals);
  }
}

const autoExtraKnown = new Set<string>();

async function loadAutoExtraTokens(): Promise<void> {
  const entries = await loadAutoExtraEntries(AUTO_EXTRA_TOKENS_FILE, AUTO_EXTRA_TOKENS_NDJSON);
  for (const entry of entries) {
    let addr = entry.address.toLowerCase();
    if (addr.startsWith("0x") && addr.length < 42) {
      addr = "0x" + addr.slice(2).padStart(40, "0");
    }
    autoExtraKnown.add(addr);
    registryCache.set(addr, safeDecimals(entry.decimals));
  }
}

let warmUpPromise: Promise<void> | null = null;

async function warmUpCache() {
  if (cacheLoaded) return;
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    await initDb();
    if (db) {
      const stmt = db.prepare("SELECT address, decimals FROM token_decimals");
      const rows = stmt.all() as { address: string; decimals: number }[];
      for (const row of rows) {
        let addr = row.address.toLowerCase();
        if (addr.startsWith("0x") && addr.length < 42) {
          addr = "0x" + addr.slice(2).padStart(40, "0");
        }
        registryCache.set(addr, row.decimals);
      }
    }
    await loadDiscoveredDecimals();
    for (const [addr, decimals] of Object.entries(discoveredDecimals)) {
      registryCache.set(addr, decimals);
    }
    await loadAutoExtraTokens();
    if (process.env.VITEST === "true") {
      seedVitestRegistry();
    }
    cacheLoaded = true;
    warmUpPromise = null;
  })();

  return warmUpPromise;
}

let loadDiscoveredPromise: Promise<void> | null = null;

async function loadDiscoveredDecimals() {
  if (discoveredLoaded) return;
  if (loadDiscoveredPromise) return loadDiscoveredPromise;

  loadDiscoveredPromise = (async () => {
    const data = await loadDiscoveredDecimalsEntries(DISCOVERED_DECIMALS_FILE, DISCOVERED_DECIMALS_NDJSON);
    Object.assign(discoveredDecimals, data);
    for (const addr of Object.keys(data)) persistedDiscovered.add(addr);
    discoveredLoaded = true;
    loadDiscoveredPromise = null;
  })();

  return loadDiscoveredPromise;
}

function scheduleDiscoveredDecimalsSave(): void {
  discoveredDirty = true;
  if (discoveredFlushTimer) return;
  discoveredFlushTimer = setTimeout(() => {
    discoveredFlushTimer = null;
    void flushDiscoveredDecimals();
  }, PERSIST_FLUSH_DEBOUNCE_MS);
}

async function flushDiscoveredDecimals(): Promise<void> {
  if (discoveredSavePending) return discoveredSavePending;
  if (!discoveredDirty) return;

  discoveredSavePending = (async () => {
    while (discoveredDirty) {
      discoveredDirty = false;
      const pending = Object.entries(discoveredDecimals)
        .filter(([addr]) => !persistedDiscovered.has(addr))
        .map(([address, decimals]) => ({ address, decimals }));
      if (pending.length === 0) continue;

      try {
        await appendDiscoveredDecimals(DISCOVERED_DECIMALS_NDJSON, pending);
        for (const { address } of pending) persistedDiscovered.add(address);
      } catch (e) {
        discoveredDirty = true;
        console.warn("[token_metadata] Failed to persist discovered decimals:", (e as Error).message);
        break;
      }
    }
  })().finally(() => {
    discoveredSavePending = null;
  });

  return discoveredSavePending;
}

// Best-effort append of newly discovered cold tokens so generate-tokens:auto can promote them on next indexer run.
async function appendToAutoExtraTokens(address: string, decimals: number) {
  const addr = address.toLowerCase();
  if (autoExtraKnown.has(addr)) return;
  autoExtraKnown.add(addr);

  try {
    await appendAutoExtraEntry(AUTO_EXTRA_TOKENS_NDJSON, addr, decimals);
  } catch (e) {
    autoExtraKnown.delete(addr);
    console.warn("[token_metadata] Failed to append to auto-extra-tokens:", (e as Error).message);
  }
}

// Permanent blocklist of addresses that are not ERC20 (no decimals()).
// A non-ERC20 contract never becomes one, so no TTL — skip forever.
const failedTokens: Set<string> = new Set();
const persistedFailed = new Set<string>();
let failedLoaded = false;
let failedDirty = false;
let failedFlushTimer: ReturnType<typeof setTimeout> | null = null;
let failedSavePending: Promise<void> | null = null;

let loadFailedPromise: Promise<void> | null = null;

async function loadFailedTokens() {
  if (failedLoaded) return;
  if (loadFailedPromise) return loadFailedPromise;

  loadFailedPromise = (async () => {
    const addrs = await loadFailedTokenEntries(FAILED_DECIMALS_FILE, FAILED_DECIMALS_NDJSON);
    for (const addr of addrs) {
      failedTokens.add(addr);
      persistedFailed.add(addr);
    }
    failedLoaded = true;
    loadFailedPromise = null;
  })();

  return loadFailedPromise;
}

function scheduleFailedTokensSave(): void {
  failedDirty = true;
  if (failedFlushTimer) return;
  failedFlushTimer = setTimeout(() => {
    failedFlushTimer = null;
    void flushFailedTokens();
  }, PERSIST_FLUSH_DEBOUNCE_MS);
}

async function flushFailedTokens(): Promise<void> {
  if (failedSavePending) return failedSavePending;
  if (!failedDirty) return;

  failedSavePending = (async () => {
    while (failedDirty) {
      failedDirty = false;
      const pending = [...failedTokens].filter((addr) => !persistedFailed.has(addr));
      if (pending.length === 0) continue;

      try {
        await appendFailedTokens(FAILED_DECIMALS_NDJSON, pending);
        for (const addr of pending) persistedFailed.add(addr);
      } catch (e) {
        failedDirty = true;
        console.warn("[token_metadata] Failed to persist failed tokens:", (e as Error).message);
        break;
      }
    }
  })().finally(() => {
    failedSavePending = null;
  });

  return failedSavePending;
}

const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);
// Keep in sync with src/core/abis/erc20.ts ERC20_READ_ABI (decimals item).

/**
 * Fetches token decimals — optimized to avoid RPC as much as possible.
 *
 * Only decimals are pre-generated/sourced here because that is the *only*
 * token metadata the arbitrage engine actually uses (for amount scaling,
 * price impact, profit math, etc.).
 *
 * 1. Large static registry (fastest — 6000+ Polygon tokens, 0 RPC)
 * 2. Batched RPC (last resort)
 *
 * Cold tokens discovered via RPC are automatically appended to
 * `data/auto-extra-tokens.json` so generate-tokens:auto promotes them into the static registry.
 *
 * This is the #1 lever for V2Factory.PairCreated performance.
 */
// Used to deduplicate warnings when we repeatedly fail to fetch decimals for
// the same broken/malformed token (e.g. factory address emitted as a token).
const failedDecimalsTokens = new Set<string>();

const fetchTokenMetaHandler = async ({ input, context }: { input: { address: string }, context: any }) => {
    await warmUpCache();

    const addr = normalizeTokenAddress(input.address);

    const cached = registryCache.get(addr);
    if (cached !== undefined) {
      return { address: addr, decimals: cached, trusted: true };
    }

    // Check if there is already an in-flight request for this token
    let promise = inFlightDecimals.get(addr);
    if (promise) {
      return promise;
    }

    // Preload phase: skip cold RPC for unknown tokens — execution phase will fetch real decimals.
    if (context?.isPreload) {
      context.cache = false;
      return { address: addr, decimals: 18, trusted: false };
    }

    // Layer 3: Permanent blocklist — non-ERC20 contracts never become valid
    if (!failedLoaded) {
      await loadFailedTokens();
    }
    const isFailed = failedTokens.has(addr);
    if (isFailed) {
      return { address: addr, decimals: 18, trusted: false };
    }

    promise = (async () => {
      try {
        const decimals = await publicClient.readContract({
          address: addr as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "decimals",
        });

        const result = { address: addr, decimals: safeDecimals(Number(decimals)), trusted: true };

        // Persist successful discovery aggressively
        registryCache.set(addr, result.decimals);
        discoveredDecimals[addr] = result.decimals;
        scheduleDiscoveredDecimalsSave();
        appendToAutoExtraTokens(addr, result.decimals).catch(() => {});

        if (context.log) {
          context.log.info(`Fetched decimals for new token via RPC (persisted + auto-extra)`, {
            token: addr,
            decimals: result.decimals,
          });
        }

        return result;
      } catch (err) {
        const errStr = String(err);

        // Distinguish between definitive "this is not an ERC20 token" errors
        // and transient "the network/RPC is having trouble" errors.
        //
        // Definitive (contract-level) failures are detected via viem's *typed*
        // errors, not substring matching — viem's "returned no data" message
        // always embeds the static line "The address is not a contract.", so
        // substring matching on it cannot distinguish a genuinely empty return
        // from any other failure. Zero-data and revert both mean the address
        // does not expose a usable decimals(); malformed-input errors (bad
        // address / decode failure) are matched by substring since they are
        // about our input, not the network.
        const cause = err instanceof BaseError ? err.walk() : err;
        const isZeroData =
          cause instanceof ContractFunctionZeroDataError ||
          (err instanceof BaseError &&
            err.walk((e) => e instanceof ContractFunctionZeroDataError) !== null);
        const isReverted =
          cause instanceof ContractFunctionRevertedError ||
          (err instanceof BaseError &&
            err.walk((e) => e instanceof ContractFunctionRevertedError) !== null);
        const isMalformedInput =
          errStr.includes("Invalid address") ||
          errStr.includes("odd length") ||
          errStr.includes("cannot unmarshal");

        const isQuota = isQuotaError(err);
        const isNetwork = isNetworkError(err);

        const isDefinitiveError = isZeroData || isReverted || isMalformedInput;

        // Only add to permanent blocklist for definitive non-token errors.
        // Network/quota errors are transient and must be retried in a future
        // run — never let a timeout/5xx whose body happens to contain a
        // definitive-looking word bake a valid token into the blocklist.
        if (isDefinitiveError && !isQuota && !isNetwork) {
          failedTokens.add(addr);
          scheduleFailedTokensSave();
        }

        if (context.log && !failedDecimalsTokens.has(addr)) {
          failedDecimalsTokens.add(addr);

          if (isQuota) {
            context.log.warn(
              `Alchemy quota / monthly capacity exceeded while fetching decimals. ` +
                `Add more providers to POLYGON_RPC_URLS (comma-separated) or lower effect rateLimits temporarily. ` +
                `Defaulting to 18 for this token (will retry in ~5min).`,
              { token: addr },
            );
          } else if (isNetwork) {
            context.log.warn(`Network error fetching decimals for token — defaulting to 18 (will retry in ~5min)`, {
              token: addr,
              error: errStr.split("\n")[0],
            });
          } else if (isDefinitiveError) {
            context.log.warn(`Definitive failure fetching decimals for token — defaulting to 18 (added to permanent blocklist)`, {
              token: addr,
              error: errStr.split("\n")[0], // Keep logs clean
            });
          }
        }

        // Do not cache obviously bad/transient results forever in Envio effect cache.
        context.cache = false;
        return { address: addr, decimals: 18, trusted: false };
      } finally {
        inFlightDecimals.delete(addr);
      }
    })();

    inFlightDecimals.set(addr, promise);
    return promise;
  };

// Note — Preload/Execution Double-Pass Cost:
// Each handler runs twice per block (preload phase + execution phase). For cold
// tokens with no cached decimals, context.cache=false is set in the handler, which
// means Envio re-executes the RPC effect in both phases (2 eth_calls per new token
// per block). This is correct behavior (preload guarantees deterministic output),
// but doubles the RPC cost for first-seen tokens. The 2× overhead is a known
// tradeoff: ~99% of fetchTokenMeta calls resolve from the static registryCache
// (0 RPC), so only genuinely cold tokens incur the double cost. Budget holders
// should account for this when sizing RPC endpoint capacity.
export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
    },
    output: { address: S.string, decimals: S.number, trusted: S.boolean },
    rateLimit: getTokenMetaEffectRateLimit(),
    cache: process.env.VITEST === "true" || process.env.NODE_ENV === "test" ? false : true,
  },
  fetchTokenMetaHandler
);
export { fetchTokenMetaHandler };

// Warm registry before first PairCreated burst (backfill throughput).
void warmUpCache().catch(() => {});

/** @internal Vitest-only — resets module caches between isolated test cases. */
export function resetTokenMetadataCachesForTest(): void {
  if (process.env.VITEST !== "true") return;
  cacheLoaded = false;
  discoveredLoaded = false;
  failedLoaded = false;
  registryCache.clear();
  for (const key of Object.keys(discoveredDecimals)) delete discoveredDecimals[key];
  persistedDiscovered.clear();
  failedTokens.clear();
  persistedFailed.clear();
  failedDecimalsTokens.clear();
  autoExtraKnown.clear();
  discoveredDirty = false;
  failedDirty = false;
  if (discoveredFlushTimer) {
    clearTimeout(discoveredFlushTimer);
    discoveredFlushTimer = null;
  }
  if (failedFlushTimer) {
    clearTimeout(failedFlushTimer);
    failedFlushTimer = null;
  }
}
