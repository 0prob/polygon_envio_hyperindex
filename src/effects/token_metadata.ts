import { createEffect, S } from "envio";
import { parseAbi } from "viem";
import { publicClient } from "./rpc_client";
import { classifyRpcError } from "./error_classification";
import {
  DISCOVERED_DECIMALS_NDJSON,
  FAILED_DECIMALS_NDJSON,
  TOKEN_REGISTRY_DB,
} from "../utils/data_paths";
import {
  appendDiscoveredDecimals,
  appendFailedTokens,
  loadDiscoveredDecimalsEntries,
  loadFailedTokenEntries,
} from "../utils/token_disk";
import { safeDecimals } from "../utils/constants";
import { normalizeTokenAddress } from "../utils/normalize_address";

let db: any = null;

async function initDb() {
  if (db !== null) return;
  const dbPath = TOKEN_REGISTRY_DB;

  // Bun runtime (scripts, direct handler runs)
  try {
    const { Database } = await import("bun:sqlite");
    db = new Database(dbPath, { readonly: true });
    return;
  } catch {
  }

  // Node 22+ built-in sqlite (Envio indexer runtime)
  try {
    const { DatabaseSync } = await import("node:sqlite");
    db = new DatabaseSync(dbPath, { readOnly: true });
    return;
  } catch {
  }

  db = null;
}

const PERSIST_FLUSH_DEBOUNCE_MS = 2000;
// No TTL — a contract that isn't ERC20 will never become one. Permanent blocklist.

// ponytail: generic debounced NDJSON flush — two instances used for discovered + failed tokens
function createDebouncedNdjsonFlush(
  getPending: () => unknown[],
  save: (pending: unknown[]) => Promise<void>,
  label: string,
) {
  let dirty = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  let savePending: Promise<void> | null = null;

  function schedule(): void {
    dirty = true;
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, PERSIST_FLUSH_DEBOUNCE_MS);
  }

  async function flush(): Promise<void> {
    if (savePending) return savePending;
    if (!dirty) return;

    savePending = (async () => {
      while (dirty) {
        dirty = false;
        const pending = getPending();
        if (pending.length === 0) continue;
        try {
          await save(pending);
        } catch (e) {
          dirty = true;
          break;
        }
      }
    })().finally(() => {
      savePending = null;
    });

    return savePending;
  }

  function resetTimer(): void {
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }
  }

  return { schedule, flush, resetTimer };
}

// Runtime discovered decimals (persisted across restarts for this indexer instance)
const discoveredDecimals: Record<string, number> = {};
const persistedDiscovered = new Set<string>();
let discoveredLoaded = false;

const discoveredFlush = createDebouncedNdjsonFlush(
  () => Object.entries(discoveredDecimals)
    .filter(([addr]) => !persistedDiscovered.has(addr))
    .map(([address, decimals]) => ({ address, decimals })),
  (pending) => {
    const typed = pending as { address: string; decimals: number }[];
    return appendDiscoveredDecimals(DISCOVERED_DECIMALS_NDJSON, typed).then(() => {
      for (const { address } of typed) persistedDiscovered.add(address);
    });
  },
  "discovered decimals",
);

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

let warmUpPromise: Promise<void> | null = null;

async function warmUpCache() {
  if (cacheLoaded) return;
  if (warmUpPromise) return warmUpPromise;

  warmUpPromise = (async () => {
    // ponytail: reset promise on failure so next caller retries instead of
    // getting a stale rejection that deadlocks all future token lookups.
    try {
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
      cacheLoaded = true;
    } finally {
      warmUpPromise = null;
    }
  })();

  return warmUpPromise;
}

let loadDiscoveredPromise: Promise<void> | null = null;

async function loadDiscoveredDecimals() {
  if (discoveredLoaded) return;
  if (loadDiscoveredPromise) return loadDiscoveredPromise;

  loadDiscoveredPromise = (async () => {
    const data = await loadDiscoveredDecimalsEntries(DISCOVERED_DECIMALS_NDJSON);
    Object.assign(discoveredDecimals, data);
    for (const addr of Object.keys(data)) persistedDiscovered.add(addr);
    discoveredLoaded = true;
    loadDiscoveredPromise = null;
  })();

  return loadDiscoveredPromise;
}



// Permanent blocklist of addresses that are not ERC20 (no decimals()).
// A non-ERC20 contract never becomes one, so no TTL — skip forever.
const failedTokens: Set<string> = new Set();
const persistedFailed = new Set<string>();
let failedLoaded = false;

const failedFlush = createDebouncedNdjsonFlush(
  () => [...failedTokens].filter((addr) => !persistedFailed.has(addr)),
  (pending) => {
    const addrs = pending as string[];
    return appendFailedTokens(FAILED_DECIMALS_NDJSON, addrs).then(() => {
      for (const addr of addrs) persistedFailed.add(addr);
    });
  },
  "failed tokens",
);

let loadFailedPromise: Promise<void> | null = null;

async function loadFailedTokens() {
  if (failedLoaded) return;
  if (loadFailedPromise) return loadFailedPromise;

  loadFailedPromise = (async () => {
    const addrs = await loadFailedTokenEntries(FAILED_DECIMALS_NDJSON);
    for (const addr of addrs) {
      failedTokens.add(addr);
      persistedFailed.add(addr);
    }
    failedLoaded = true;
    loadFailedPromise = null;
  })();

  return loadFailedPromise;
}



const ERC20_ABI = parseAbi(["function decimals() view returns (uint8)"]);

type DecimalsFetchResult = { address: string; decimals: number; trusted: boolean };

/** Coalesce concurrent cold-token RPC reads into one multicall per tick. */
type RpcBatchWaiter = { context: { cache: boolean }; resolve: (value: DecimalsFetchResult) => void };
let pendingRpcBatch = new Map<string, RpcBatchWaiter[]>();
let rpcBatchTimer: ReturnType<typeof setTimeout> | null = null;
let rpcBatchFlushPromise: Promise<void> | null = null;

function scheduleDecimalsRpcBatch(): void {
  if (rpcBatchTimer !== null) return;
  rpcBatchTimer = setTimeout(() => {
    rpcBatchTimer = null;
    void flushDecimalsRpcBatch();
  }, 16);
}

function handleDecimalsFetchFailure(addr: string, err: unknown, context: { cache: boolean }): DecimalsFetchResult {
  const { isPermanent } = classifyRpcError(err);

  if (isPermanent) {
    failedTokens.add(addr);
    failedFlush.schedule();
  }

  context.cache = false;
  return { address: addr, decimals: 18, trusted: false };
}

function handleDecimalsFetchSuccess(addr: string, rawDecimals: unknown): DecimalsFetchResult {
  const decimals = safeDecimals(Number(rawDecimals));
  registryCache.set(addr, decimals);
  discoveredDecimals[addr] = decimals;
  discoveredFlush.schedule();
  return { address: addr, decimals, trusted: true };
}

async function flushDecimalsRpcBatch(): Promise<void> {
  if (rpcBatchFlushPromise) return rpcBatchFlushPromise;
  if (pendingRpcBatch.size === 0) return;

  const batch = pendingRpcBatch;
  pendingRpcBatch = new Map();
  const addrs = [...batch.keys()];

  rpcBatchFlushPromise = (async () => {
    try {
      const results = await publicClient.multicall({
        contracts: addrs.map((address) => ({
          address: address as `0x${string}`,
          abi: ERC20_ABI,
          functionName: "decimals",
        })),
        allowFailure: true,
      });

      for (let i = 0; i < addrs.length; i++) {
        const addr = addrs[i]!;
        const waiters = batch.get(addr) ?? [];
        const item = results[i];
        for (const waiter of waiters) {
          if (item?.status === "success") {
            waiter.resolve(handleDecimalsFetchSuccess(addr, item.result));
          } else {
            waiter.resolve(handleDecimalsFetchFailure(addr, item?.error ?? new Error("multicall failure"), waiter.context));
          }
        }
        inFlightDecimals.delete(addr);
      }
    } catch (err) {
      for (const [addr, waiters] of batch) {
        for (const waiter of waiters) {
          waiter.resolve(handleDecimalsFetchFailure(addr, err, waiter.context));
        }
        inFlightDecimals.delete(addr);
      }
    }
  })().finally(() => {
    rpcBatchFlushPromise = null;
  });

  return rpcBatchFlushPromise;
}

function enqueueDecimalsRpc(addr: string, context: { cache: boolean }): Promise<DecimalsFetchResult> {
  const existing = inFlightDecimals.get(addr);
  if (existing) return existing;

  const promise = new Promise<DecimalsFetchResult>((resolve) => {
    const waiters = pendingRpcBatch.get(addr) ?? [];
    waiters.push({ context, resolve });
    pendingRpcBatch.set(addr, waiters);

    const maxBatch = 64;
    if (pendingRpcBatch.size >= maxBatch) {
      if (rpcBatchTimer) {
        clearTimeout(rpcBatchTimer);
        rpcBatchTimer = null;
      }
      void flushDecimalsRpcBatch();
    } else {
      scheduleDecimalsRpcBatch();
    }
  });

  inFlightDecimals.set(addr, promise);
  return promise;
}

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
 * Cold tokens discovered via RPC are appended to `data/discovered-decimals.ndjson`
 * and merged into `data/token_registry.db` on the next `bun run generate-tokens` run.
 *
 * This is the #1 lever for V2Factory.PairCreated performance.
 */
const fetchTokenMetaHandler = async ({ input, context }: { input: { address: string }; context: { cache: boolean; isPreload?: boolean } }) => {
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

  promise = enqueueDecimalsRpc(addr, context);
  return promise;
};

// Preload skips cold-token RPC (returns placeholder 18); execution uses multicall-batched RPC.
// ~99% of lookups hit registryCache before any effect RPC runs.
export const fetchTokenMeta = createEffect(
  {
    name: "fetchTokenMeta",
    input: {
      address: S.string,
    },
    output: { address: S.string, decimals: S.number, trusted: S.boolean },
    rateLimit: { calls: 250, per: "second" as const },
    cache: true,
  },
  fetchTokenMetaHandler
);
// Warm registry before first PairCreated burst (backfill throughput).
void warmUpCache().catch(() => {});
