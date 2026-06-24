# Bug Log

| Date | Time | Description | Status |
|------|------|-------------|--------|
| 2026-06-22 | 08:15 UTC | src/handlers/curve_factory.ts:54 — `event.params.pool` undefined for overloaded PoolAdded variants (params named `_0`); pool address + n_coins silently lost | FIXED |
| 2026-06-22 | 08:15 UTC | src/effects/curve_metadata.ts:32-35 — `curveFeeToBps` returns default 4 bps for sub-bps fees due to integer division truncation | FIXED |
| 2026-06-23 | 12:00 UTC | src/handlers/curve_bootstrap.ts — `storeProgress` ran during preload and on all-metadata-failure pages, advancing `CurveBootstrapProgress` without writing `PoolMeta` (permanent registry pool skip) | FIXED |
| 2026-06-23 | 21:55 UTC | src/effects/token_metadata.ts — `token_registry.db` resolved to `/home/x/arb/` (`../../../`) instead of project root; static registry skipped at runtime | FIXED |
| 2026-06-23 | 21:55 UTC | src/effects/dodo_metadata.ts — block-pinned fee reads at pool creation often empty; no latest-state fallback → mass UWARN + default 10 bps fee | FIXED |
| 2026-06-23 | 22:35 UTC | Token data consolidated under `data/` (`token_registry.db`, ndjson overlays); external URL fetch removed from generate-tokens | FIXED |
| 2026-06-23 | 22:56 UTC | fetchTokenMeta cold-path RPC batched via viem multicall (was one readContract per token) | FIXED |
