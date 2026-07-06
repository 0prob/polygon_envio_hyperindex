# Polygon (137) DEX Pool Discovery Indexer

Envio HyperIndex pipeline that indexes DEX pool creation events on Polygon. Feeds pool discovery metadata to an arbitrage bot via Hasura GraphQL.

**Protocols:** Uniswap V2/V3/V4, SushiSwap V2/V3, QuickSwap V2/V3/V4, Dfyn, MeshSwap, JetSwap, Cometh, Curve, Balancer V2, DODO V2, WOOFi.

## Quick Start

```bash
bun install
cp .env.example .env   # fill in ENVIO_API_TOKEN + RPC URLs
bun run dev             # auto-runs codegen on schema/config changes
```

## Environment

See `.env.example` for all variables. Key ones:

| Variable | Required | Description |
|---|---|---|
| `ENVIO_API_TOKEN` | Yes | Envio API token for HyperSync |
| `ENVIO_POLYGON_RPC_URLS` | Yes | Comma-separated archival RPC endpoints for metadata effects |
| `ENVIO_POLYGON_HYPERSYNC_URL` | No | HyperSync endpoint (default: `https://polygon.hypersync.xyz`) |
| `ENVIO_FULL_BATCH_SIZE` | No | Blocks per HyperSync request (auto-tuned from RPM target) |
| `ENVIO_HYPERSYNC_RPM_TARGET` | No | Max HyperSync requests/min for pacing (default: 180) |
| `ENVIO_POLYGON_START_BLOCK` | No | Override start block; `POLYGON_START_BLOCK` alias works too |
| `INDEXER_PROGRESS_REALTIME_START` | No | Block to switch from historical→realtime stride (default: 65M) |
| `INDEXER_PROGRESS_HISTORICAL_EVERY` | No | Historical progress stride (default: 4000) |
| `INDEXER_PROGRESS_REALTIME_EVERY` | No | Realtime progress stride (default: 500) |
| `ENVIO_NODE_MAX_OLD_SPACE_MB` | No | Node V8 heap cap for historical backfill (default: 8192) |

RPC URL resolution follows a priority chain: `ENVIO_POLYGON_RPC_URLS` → `ENVIO_POLYGON_RPC_URL` → `POLYGON_RPC_URLS` → `POLYGON_RPC_URL` → `POLYGON_RPC`. Public fallback endpoints are appended when fewer than 3 user endpoints are configured.

## Schema (5 entities)

| Entity | Purpose |
|---|---|
| **PoolMeta** | Pool address, protocol, tokens, fee, block, V4 hooks, Balancer poolId/specialization/poolType |
| **TokenMeta** | ERC-20 decimals cache (static registry + RPC fallback) |
| **IndexerProgress** | Per-chain last-processed block for bot lag monitoring |
| **CurveBootstrapProgress** | Curve per-factory pagination state (resumes on restart) |
| **BalancerPoolIdMapping** | bytes32 poolId → pool address (bridges TokensRegistered) |

PoolMeta auto-detects Balancer pool types: `weighted` (has normalized weights), `stable` (has amplification parameter > 0), `linear` (has main/wrapped token pair). `specialization` stores the Balancer Vault PoolSpecialization enum (0 general, 1 minimal, 2 two-token).

## Architecture

```
HyperSync → onEvent/onBlock handlers → Effect API → Postgres via Hasura
                          ↕                              ↘
              Static registry (data/token_registry.db)   Arbitrage bot
              Discovered decimals (ndjson)               (GraphQL queries)
              RPC fallback (viem multicall batch)        (LISTEN/NOTIFY)
              Error classification (permanent/transient)
```

All pool discovery is via factory/registry `onEvent` handlers and `onBlock` bootstrap handlers. No per-pool `contractRegister` subscriptions — the arb bot owns hot state via direct RPC.

**Effects** resolve token decimals and pool metadata using layered sources: `data/token_registry.db` → `data/discovered-decimals.ndjson` → batched RPC multicall. Token resolution costs ~0 RPC for the 180k+ pre-registered Polygon tokens.

**Error classification** (`src/effects/error_classification.ts`) distinguishes permanent errors (contract doesn't implement interface, reverted, bad input) from transient errors (rate limit, network timeout). Permanent errors cache the failure so the effect is never retried; transient errors retry on the next handler execution.

**RPC client** (`src/effects/rpc_client.ts`) supports multi-endpoint fallback with lazy initialization via a `Proxy`. Public fallback URLs are appended when the user provides fewer than 3 endpoints. Transport tuning (batch sizes, timeouts, retries) is exposed via `getRpcTransportTuning()`.

**PostgreSQL LISTEN/NOTIFY** (`migrations/002_notify_pool_meta.sql`) sends a JSON payload with pool address and protocol on every PoolMeta INSERT or UPDATE, so the Rust bot can trigger immediate discovery instead of polling.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Run indexer (env alias bridging + heap sizing, then `envio dev`) |
| `bun run codegen` | Re-generate TypeScript types from config + schema |
| `bun run validate-config` | Static analysis: config.yaml vs ABIs, handlers, schema |
| `bun run validate-data` | Validate local token data files and `data/token_registry.db` |
| `bun run validate` | Run both validate-config and validate-data |
| `bun run generate-tokens` | Merge local data into `data/token_registry.db` (no network fetch) |
| `bun run backup-db` | pg_dump the Hasura database |

## Database Migrations

| File | Purpose |
|---|---|
| `migrations/001_pool_meta_indexes.sql` | Composite B-tree index on `PoolMeta("createdBlock", id)` for keyset-paginated bootstrap queries |
| `migrations/002_notify_pool_meta.sql` | `LISTEN/NOTIFY` trigger on `PoolMeta` for real-time pool discovery notification |

Run after Envio schema creation:
```bash
psql "$PG_URL" -f migrations/001_pool_meta_indexes.sql
psql "$PG_URL" -f migrations/002_notify_pool_meta.sql
```

## Files

| Path | Role |
|---|---|
| `src/handlers/` | onEvent/onBlock handlers (10 files, one per protocol) |
| `src/effects/` | Envio Effect API implementations (token, curve, balancer, dodo, algebra, woofi) |
| `src/effects/error_classification.ts` | RPC error classifier: permanent vs transient for caching decisions |
| `src/effects/rpc_client.ts` | Multi-endpoint viem client with lazy init, public fallbacks, transport tuning |
| `src/utils/` | Guards, pacing, entity writes, constants, address normalization |
| `scripts/` | Dev launcher, validation, token registry generator, db backup |
| `scripts/envio-dev.ts` | Dev wrapper bridging root .env aliases to ENVIO_* vars, sets Node heap |
| `abis/` | JSON ABIs for all indexed contracts |
| `migrations/` | Post-deploy SQL migrations (indexes, LISTEN/NOTIFY trigger) |
| `data/token_registry.db` | Static SQLite decimals lookup (~180k tokens, 0 RPC at runtime) |
| `data/pools.json` | Bot anchor pool token addresses (optional input to `generate-tokens`) |
| `data/discovered-decimals.ndjson` | Append-only RPC discoveries (runtime overlay + registry rebuild input) |
| `data/failed-decimals.ndjson` | Permanent non-ERC20 blocklist (append-only, created at runtime) |

## Notable Changes

### Package Manager: pnpm → bun
The project switched from pnpm to bun. `pnpm-lock.yaml` and `pnpm-workspace.yaml` were removed. Use `bun install` instead of `pnpm install`.

### Error Classification
All effects now use `classifyRpcError()` from `src/effects/error_classification.ts` to distinguish permanent errors (contract doesn't implement interface, reverted, malformed input) from transient errors (rate-limited, network/timeout). Permanent errors set the Effect API `cache` flag so the failed result is persisted and never re-tried.

### Curve: MetaRegistry → Direct Factory Bootstrap
The Curve MetaRegistry contract is deprecated/broken on Polygon. Bootstrap now queries each Curve factory's native `pool_count()`/`pool_list()` directly for 4 factories: twocrypto-ng, tricrypto-ng, stableswap-ng, and crypto-legacy. Per-page transient retry handling prevents permanent stalls.

### Balancer Pool Type Detection
`fetchBalancerMetadataHandler` probes capability getters (`getNormalizedWeights`, `getAmplificationParameter`, `getMainToken`/`getWrappedToken`) to auto-detect pool type: `weighted`, `stable`, or `linear`. The `specialization` field stores the Balancer Vault PoolSpecialization enum value.

## Constraints

- **Polygon-only** (chain id 137). No multichain setup.
- **HyperSync-only.** RPC fallback disabled to avoid fatal wildcard-contract errors.
- **No hot pool state.** This indexer discovers pools and writes metadata; the arb bot reads pool state via RPC.
- **Reorgs handled automatically** via `rollback_on_reorg: true` (max depth 150). Module-level caches (Balancer poolId cache) self-heal on entity rollback.
