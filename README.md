# arb-bot-ingestion

Envio HyperIndex pipeline that indexes DEX pool creation events on Polygon. Feeds pool discovery metadata to an arbitrage bot via Hasura GraphQL.

**Protocols indexed:** Uniswap V2/V3/V4, SushiSwap V2/V3, QuickSwap V2/V3, Kyber Elastic, Ramses V3, Curve, Balancer V2, DODO V2, WOOFi, and more.

## Quick Start

```bash
# Install deps
bun install

# Copy and fill in env vars
cp .env.example .env

# Generate token registry (optional: ~85k Polygon tokens)
bun run generate-tokens

# Run the indexer (auto-runs codegen on schema/config changes)
bun run dev
```

## Environment

See `.env.example` for all variables. Key ones:

| Variable | Required | Description |
|---|---|---|
| `ENVIO_API_TOKEN` | Yes | Envio API token |
| `ENVIO_POLYGON_RPC_URLS` | Yes | Comma-separated RPC endpoints for effects |
| `ENVIO_FULL_BATCH_SIZE` | No | Blocks per HyperSync request (default: 6000) |
| `ENVIO_HYPERSYNC_RPM_TARGET` | No | Rate limit for effect concurrency (default: 200) |
| `ENVIO_POLYGON_START_BLOCK` | No | Override start block for partial re-sync |

## Schema

Three entities written to Postgres via Hasura:

- **PoolMeta** — Discovered pool metadata (address, protocol, tokens, fee, block). Indexed by protocol + block for bot queries.
- **TokenMeta** — ERC20 decimals cache, populated on first-seen tokens via Effect API + static registry.
- **IndexerProgress** — Per-chain progress signal (last processed block) for bot lag monitoring.

## Architecture

```
HyperSync → Event Handlers → Effect API (token/curve/balancer metadata) → Postgres via Hasura
                                                                              ↓
                                                                   Arbitrage bot (GraphQL queries)
```

Handlers in `src/handlers/` process factory events (PairCreated, PoolCreated, Initialize, etc.) and dynamically register pools via `contractRegister`. Effects in `src/effects/` fetch token decimals, pool metadata, and curve registry data using batched RPC calls.

## Commands

| Command | Purpose |
|---|---|
|`bun run dev`       | Run indexer with auto-codegen and env loading |
|`bun run codegen    `| Re-generate TypeScript types from config.yaml + schema.graphql |
|`bun run generate-tokens:auto` | Update static token decimals registry from chain.artemis + Covalent |