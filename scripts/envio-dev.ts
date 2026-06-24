#!/usr/bin/env bun
/**
 * Start Envio with root .env aliases bridged to ENVIO_* keys (batch size, start block, RPC).
 * The arb bot does the same via `buildHyperIndexChildEnv`; this wrapper covers standalone runs.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { applyHyperSyncPacingEnv } from "../src/utils/pacing.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const raw = process.argv.slice(2);
const subcommand = raw[0]?.startsWith("-") ? "dev" : raw[0] ?? "dev";
const extraArgs = raw[0]?.startsWith("-") ? raw : raw.slice(1);

const env: Record<string, string | undefined> = { ...process.env };
applyHyperSyncPacingEnv(env);

const envioBin = path.resolve(ROOT, "node_modules/.bin/envio");
const child = spawn(envioBin, [subcommand, ...extraArgs], {
  cwd: ROOT,
  env: env as NodeJS.ProcessEnv,
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 1));

setInterval(() => {
  if (performance.getEntriesByType("measure").length > 500_000) {
    performance.clearMeasures();
    performance.clearMarks();
  }
}, 60_000);
