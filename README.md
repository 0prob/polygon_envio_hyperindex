# Polygon (137) DEX Pool Discovery Indexer

Envio HyperIndex pipeline that indexes DEX pool creation events on Polygon. Feeds pool discovery metadata to an arbitrage bot via Hasura GraphQL.

**Protocols:** Uniswap V2/V3/V4, SushiSwap V2/V3, QuickSwap V2/V3, Kyber Elastic, Ramses V3, Curve, Balancer V2, DODO V2, WOOFi, and unknown-V2/V3 catch-all.

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

## Schema (5 entities)

| Entity | Purpose |
|---|---|
| **PoolMeta** | Pool address, protocol, tokens, fee, block, V4 hooks, Balancer poolId |
| **TokenMeta** | ERC-20 decimals cache (static registry + RPC fallback) |
| **IndexerProgress** | Per-chain last-processed block for bot lag monitoring |
| **CurveBootstrapProgress** | Curve registry pagination state (resumes on restart) |
| **BalancerPoolIdMapping** | bytes32 poolId → pool address (bridges TokensRegistered) |

## Architecture

```
HyperSync → onEvent/onBlock handlers → Effect API → Postgres via Hasura
                          ↕                              ↘
              Static registry (token_registry.db)    Arbitrage bot
              Discovered decimals (ndjson)            (GraphQL queries)
              RPC fallback (viem multicall)
```

All pool discovery is via factory/registry `onEvent` handlers and `onBlock` bootstrap handlers. No per-pool `contractRegister` subscriptions — the arb bot owns hot state via direct RPC.

Effects (`createEffect` with preload optimization) resolve token decimals and pool metadata using layered sources: static SQLite registry → discovered-decimals cache → RPC. Token resolution costs ~0 RPC for the 6000+ pre-registered Polygon tokens.

## Commands

| Command | Purpose |
|---|---|
| `bun run dev` | Run indexer with auto-codegen + env loading |
| `bun run codegen` | Re-generate TypeScript types from config + schema |
| `bun run generate-tokens` | Build `data/discovered-decimals.json` (~85k tokens) |
| `bun run generate-tokens:auto` | Incrementally promote RPC-discovered tokens into static registry |
| `bun run backup-db` | pg_dump the Hasura database |
| `bun test` | Vitest suite for effects, handlers, and utilities |

## Files

| Path | Role |
|---|---|
| `src/handlers/` | onEvent/onBlock handlers (10 files, one per protocol) |
| `src/effects/` | Envio Effect API implementations (token, curve, balancer, dodo, woofi) |
| `src/utils/` | Guards, pacing, entity writes, constants, address normalization |
| `abis/` | JSON ABIs for all indexed contracts |
| `token_registry.db` | Static SQLite decimals lookup (6000+ tokens, 0 RPC) |
| `data/discovered-decimals.ndjson` | RPC-discovered tokens persisted across restarts |
| `data/auto-extra-tokens.ndjson` | Cold tokens queued for registry promotion |
| `doc/MEMORIES.md` | Bug log and development context |
| `scripts/validate_envio_config.py` | Static analysis: config.yaml vs ABI event signatures, types, anonymous events |

## Constraints

- **Polygon-only** (chain id 137). No multichain setup.
- **HyperSync-only.** RPC fallback disabled to avoid fatal wildcard-contract errors.
- **No hot pool state.** This indexer discovers pools and writes metadata; the arb bot reads pool state via RPC.
- **Reorgs handled automatically** via `rollback_on_reorg: true` (max depth 200). Module-level caches (Balancer poolId cache) self-heal on entity rollback.
