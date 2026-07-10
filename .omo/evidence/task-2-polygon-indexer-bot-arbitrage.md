# Todo 2 evidence: Algebra incomplete-row repair

The existing `src/handlers/algebra_factory.ts` path now reads `PoolMeta` before
the metadata effect, retries rows whose `fee` or `tickSpacing` is null, and
leaves the row unchanged when the effect returns the failure sentinel `fee=0`.
This keeps incomplete rows recoverable and prevents corrupt routable metadata.

## Deterministic fixture QA

`bun scripts/test_algebra_repair.ts` passed:

- complete metadata repair (`fee=500`, `tickSpacing=60`);
- failed RPC sentinel (`fee=0`) produces no write;
- 500 rows produce one committed batch/checkpoint;
- 501 rows produce two checkpoints (`500`, `501`).

The repository has no production migration/backfill runner surface, so the
500/501 assertions are a deterministic checkpoint harness rather than a live
database transaction test.

## Gates

- `bun run validate`: passed (0 errors; existing informational/warning output).
- `bunx tsc --noEmit`: passed.
- `bun run codegen`: passed.

