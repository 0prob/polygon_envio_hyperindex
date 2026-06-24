# Bug Log

| Date | Time | Description | Status |
|------|------|-------------|--------|
| 2026-06-22 | 08:15 UTC | src/handlers/curve_factory.ts:54 — `event.params.pool` undefined for overloaded PoolAdded variants (params named `_0`); pool address + n_coins silently lost | FIXED |
| 2026-06-22 | 08:15 UTC | src/effects/curve_metadata.ts:32-35 — `curveFeeToBps` returns default 4 bps for sub-bps fees due to integer division truncation | FIXED |
| 2026-06-23 | 12:00 UTC | src/handlers/curve_bootstrap.ts — `storeProgress` ran during preload and on all-metadata-failure pages, advancing `CurveBootstrapProgress` without writing `PoolMeta` (permanent registry pool skip) | FIXED |
