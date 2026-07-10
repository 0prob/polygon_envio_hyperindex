import { strict as assert } from "node:assert";

type PoolRow = { id: string; fee: number | null; tickSpacing: number | null };
type RepairResult = { fee: number; tickSpacing: number };

const incompleteRows = (count: number): PoolRow[] =>
  Array.from({ length: count }, (_, index) => ({
    id: `0x${index.toString(16).padStart(40, "0")}`,
    fee: null,
    tickSpacing: null,
  }));

const repair = (rows: readonly PoolRow[], effects: ReadonlyMap<string, RepairResult>): PoolRow[] => {
  const repaired: PoolRow[] = [];
  for (const row of rows) {
    const meta = effects.get(row.id);
    if (!meta || meta.fee === 0) continue;
    repaired.push({ ...row, fee: meta.fee, tickSpacing: meta.tickSpacing });
  }
  return repaired;
};

const commitBatches = (rows: readonly PoolRow[], size: number): { commits: number; checkpoints: number[] } => {
  const checkpoints: number[] = [];
  for (let offset = size; offset <= rows.length; offset += size) checkpoints.push(offset);
  if (rows.length % size !== 0) checkpoints.push(rows.length);
  return { commits: checkpoints.length, checkpoints };
};

const run = (): void => {
  const happy = incompleteRows(1);
  const happyEffects = new Map([[happy[0]?.id ?? "", { fee: 500, tickSpacing: 60 }]]);
  assert.deepEqual(repair(happy, happyEffects), [{ ...happy[0], fee: 500, tickSpacing: 60 }]);

  const failed = incompleteRows(1);
  assert.deepEqual(repair(failed, new Map([[failed[0]?.id ?? "", { fee: 0, tickSpacing: 60 }]])), []);

  assert.deepEqual(commitBatches(incompleteRows(500), 500), { commits: 1, checkpoints: [500] });
  assert.deepEqual(commitBatches(incompleteRows(501), 500), { commits: 2, checkpoints: [500, 501] });
  console.log("algebra repair fixtures: PASS (happy, failed RPC, 500/501 checkpoints)");
};

run();
