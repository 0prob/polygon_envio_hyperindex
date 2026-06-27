import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repo root (`src/utils` → `../..`). */
export const PROJECT_ROOT = path.resolve(
  import.meta.dir ?? path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);

export const DATA_DIR = path.join(PROJECT_ROOT, "data");

export const TOKEN_REGISTRY_DB =
  process.env.TOKEN_REGISTRY_DB?.trim() || path.join(DATA_DIR, "token_registry.db");

/** Bot anchor pools — token addresses the arb engine trades (optional, defaults decimals to 18). */
export const POOLS_JSON =
  process.env.POOLS_JSON?.trim() || path.join(DATA_DIR, "pools.json");

/** Manual decimal overrides not yet in public lists. */
export const EXTRA_TOKENS_JSON = path.join(DATA_DIR, "extra-tokens.json");

/** Append-only log of RPC-discovered decimals (runtime overlay + registry rebuild input). */
export const DISCOVERED_DECIMALS_NDJSON = path.join(DATA_DIR, "discovered-decimals.ndjson");

/** Append-only blocklist of addresses that are not ERC20 (no usable decimals()). */
export const FAILED_DECIMALS_NDJSON = path.join(DATA_DIR, "failed-decimals.ndjson");
