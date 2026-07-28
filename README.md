# Polygon (137) DEX Pool Discovery Indexer

Envio HyperIndex pipeline that indexes DEX pool-creation events on Polygon and writes discovery metadata for the arbitrage bot ([0prob/rust_polygon_arbitrage_bot](https://github.com/0prob/rust_polygon_arbitrage_bot)) via Postgres + `LISTEN/NOTIFY` (Hasura GraphQL disabled).

**Protocols:** Uniswap V2/V3/V4, SushiSwap V2/V3, QuickSwap V2/V3/V4 (Algebra), Curve, Balancer V2, DODO V2, WOOFi.

## Quick Start

```bash
bun install
cp .env.example .env   # set ENVIO_API_TOKEN + ENVIO_POLYGON_RPC_URLS
bun run dev            # env alias bridge + singleton kill, then envio dev
bun run migrate-db     # after first Envio Postgres is up (indexes + NOTIFY + bootstrap reopen)
```

Requires: **Bun**, **Docker** (Envio Postgres), **psql** (for `migrate-db`), archival Polygon RPCs for metadata effects.

## Environment

See `.env.example` for the full set. Keys the code / Envio config actually read:

| Variable | Required | Description |
|---|---|---|
| `ENVIO_API_TOKEN` | Yes | Envio HyperSync API token |
| `ENVIO_HASURA` | No | Forced `false` by `bun run dev` — Hasura GraphQL disabled |
| `ENVIO_POLYGON_RPC_URLS` | Yes* | Comma-separated archival RPCs for Effect metadata reads |
| `ENVIO_POLYGON_RPC_URL` / `POLYGON_RPC_URLS` / `POLYGON_RPC_URL` / `POLYGON_RPC` | No | Aliases; first non-empty key in that order wins (`rpc_client.ts`). `bun run dev` also bridges `POLYGON_*` → `ENVIO_POLYGON_*` |
| `ENVIO_POLYGON_HYPERSYNC_URL` | No | HyperSync URL (default `https://polygon.hypersync.xyz`) |
| `ENVIO_FULL_BATCH_SIZE` | No | Blocks per HyperSync request (default `6000` via `config.yaml`) |
| `ENVIO_POLYGON_START_BLOCK` / `POLYGON_START_BLOCK` | No | Override contract/chain start blocks |
| `INDEXER_PROGRESS_REALTIME_START` | No | Historical→realtime progress stride switch (default `65000000`) |
| `INDEXER_PROGRESS_HISTORICAL_EVERY` | No | Historical progress every N blocks (default `4000`) |
| `INDEXER_PROGRESS_REALTIME_EVERY` | No | Realtime progress every N blocks (default `500`) |
| `BALANCER_POOLTYPE_REPAIR_EVERY` | No | Balancer incomplete-row repair stride (default `2000`) |
| `BALANCER_POOLTYPE_REPAIR_BATCH` | No | Pools repaired per stride (default `8`) |
| `BALANCER_POOLTYPE_REPAIR_START` | No | First block for Balancer repair onBlock (default `65000000`) |
| `CURVE_BOOTSTRAP_FROM_BLOCK` | No | First block for Curve factory `pool_list` bootstrap (default `90000000`; mid-backfill + bad RPC freezes `progress_block`) |
| `FACTORY_EVENT_RECONCILIATION_EVERY` | No | Blocks between one HyperSync event-source reconciliation page (default `500`) |
| `V2_RECONCILIATION_EVERY` | No | Blocks between bounded V2 factory enumeration pages (default `500`) |
| `ENVIO_NODE_MAX_OLD_SPACE_MB` | No | V8 heap for `envio-dev` (default `8192`) |
| `ENVIO_KILL_GRACE_MS` | No | Grace before SIGKILL of prior indexer processes (default `2000`) |
| `ENVIO_LOG_LEVEL` | No | Envio log level |
| `PG_URL` / `ENVIO_PG_URL` / `DATABASE_URL` | No | Postgres URL for `migrate-db` |
| `ENVIO_POSTGRES_*` | No | Container/db defaults for `migrate-db`, `backup-db`, `repair-balancer-pooltype` |
| `BACKUP_DIR` | No | Output dir for `backup-db` (default `backups/`) |
| `TOKEN_REGISTRY_DB` | No | SQLite token registry path (default `data/token_registry.db`) |
| `POOLS_JSON` | No | Anchor pools JSON for `generate-tokens` (default `data/pools.json`) |

\*If unset, `rpc_client.ts` uses built-in public Polygon RPCs (often non-archival / rate-limited). When `ENVIO_POLYGON_RPC_URLS` (or aliases) is set, only those URLs are used — keep them healthy; dead endpoints ahead of a good one stall Effect calls via viem `fallback()`.

## Schema (7 entities)

| Entity | Purpose |
|---|---|
| **PoolMeta** | Pool address, protocol, tokens, fee, blocks, V4 hooks, Balancer poolId/specialization/poolType |
| **TokenMeta** | ERC-20 decimals cache |
| **IndexerProgress** | Per-chain last-processed block (bot lag) |
| **CurveBootstrapProgress** | Per-factory Curve `pool_list` pagination |
| **V2FactoryReconciliationProgress** | Per-factory V2 enumeration cursor |
| **FactoryEventReconciliationProgress** | Per-event-source HyperSync replay cursor |
| **BalancerPoolIdMapping** | bytes32 poolId → pool address |

Balancer `poolType`: `weighted` / `stable` / `linear` from capability probes. Curve discovery types include `stable`, `crypto`, `stable_ng`, `crypto_ng`. Deploy events prefer embedded fee/`mid_fee`/`packed_fee_params` + coins; Effect path uses `fee()` with `mid_fee` fallback when the event is incomplete.

## Architecture

```
HyperSync (chain logs) → onEvent / onBlock handlers → Effect API (RPC) → Postgres
        ↑                                                      ↘
  ENVIO_API_TOKEN + hypersync_config              LISTEN/NOTIFY → arbitrage bot
                                                  (Hasura GraphQL off)
```

- **Chain ingestion** is HyperSync-only (`hypersync_config` in `config.yaml`). There is no Envio RPC chain fallback.
- **Effects** still use viem RPC (`src/effects/rpc_client.ts`) for decimals and protocol metadata.
- **No per-pool `contractRegister`.** Discovery is factory/registry events + Curve/WOOFi/Balancer onBlock helpers. Hot pool state lives in the bot via RPC.
- **Token decimals:** `data/token_registry.db` → `data/discovered-decimals.ndjson` → multicall RPC.
- **Errors:** `classifyRpcError()` — permanent failures are cached; transient failures retry.
- **Curve:** MetaRegistry is unused (broken on Polygon). Factory `onEvent` handlers write pools from deploy-event fee/coins when present (avoids RPC stalls). Bootstrap (deferred by default to ~90M) pages each factory’s `pool_count`/`pool_list` at the handler block; growth re-probes after completion. Incomplete rows (fee 0/null, thin tokens) are re-enriched.
- **Balancer:** Incomplete `poolType`/`fee`/tokens are tracked in-process and repaired on a slow onBlock stride; ops script `repair-balancer-pooltype` repairs from SQL for cold starts.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Indexer (`scripts/envio-dev.ts` → `envio dev`) |
| `bun run run` | Same wrapper with `envio run` |
| `bun run test` | Vitest + `createTestIndexer` (replay/reorg checks) |
| `bun run codegen` | Regenerate types from `config.yaml` + `schema.graphql` |
| `bun run validate` / `validate-config` / `validate-data` | Static checks |
| `bun run generate-tokens` | Rebuild `data/token_registry.db` from local data (no network) |
| `bun run migrate-db` | Apply `migrations/001`–`008` |
| `bun run backup-db` | `pg_dump` via Docker `envio-postgres` |
| `bun run repair-balancer-pooltype` | One-shot Balancer poolType/fee repair (RPC + SQL) |

```bash
bun run migrate-db
bun scripts/repair-balancer-pooltype.ts --dry-run
bun scripts/repair-balancer-pooltype.ts --pooltype-only   # skip null-fee-only rows
```

## Database Migrations

| File | Purpose |
|---|---|
| `001_pool_meta_indexes.sql` | Keyset index `("createdBlock", id)` |
| `002_notify_pool_meta.sql` | `LISTEN/NOTIFY` on PoolMeta write |
| `003_composite_incremental_index.sql` | `("createdBlock", "updatedAtBlock")` |
| `004_pool_meta_updated_index.sql` | `"updatedAtBlock"` index |
| `005_pool_meta_index_cleanup.sql` | Drop redundant legacy indexes |
| `006_remove_zombie_v2_protocols.sql` | Delete obsolete V2 protocol rows (idempotent `::text` match) |
| `007_pool_meta_updated_keyset_index.sql` | `("updatedAtBlock", id)` keyset index |
| `008_reopen_curve_bootstrap.sql` | Reset `CurveBootstrapProgress` after historical `pool_count` fix |

Default Docker DB: `postgres://postgres:testing@localhost:5433/envio-dev`.

## Layout

| Path | Role |
|---|---|
| `src/handlers/` | Event/block handlers (V2/V3/V4, Algebra, Curve, Balancer, DODO, WOOFi, progress) |
| `src/effects/` | Effect API (token, Curve, Balancer, DODO, Algebra, WOOFi, RPC client, error classification) |
| `src/utils/` | Constants, guards, pacing, entity writes |
| `scripts/` | `envio-dev`, validate, migrate, backup, token generate, Balancer repair |
| `abis/` | Contract ABIs |
| `migrations/` | Post-Envio SQL |
| `data/token_registry.db` | Static decimals SQLite (gitignored; build via `generate-tokens`) |
| `data/pools.json` | Optional anchor pools for token generation |
| `data/*.ndjson` | Runtime decimal discovery / failure overlays (gitignored) |

## Constraints

- **Polygon only** (chain id `137`).
- **HyperSync for log ingest** (Envio `3.4.0`). Archival RPC still required for Effect reads (token decimals, incomplete Curve/Balancer metadata, Curve bootstrap).
- **Hasura GraphQL disabled** (`ENVIO_HASURA=false`). Entity schema remains `schema.graphql` for Envio codegen/Postgres; the bot queries Postgres directly.
- **No hot pool state** in this repo — metadata only.
- **Reorgs:** `rollback_on_reorg: true`, `max_reorg_depth: 150`. Handler side effects (RPC) are not rolled back; Balancer in-memory poolId cache self-heals on entity rollback.
- Package manager is **Bun** (not pnpm).
