#!/usr/bin/env bun
/**
 * Start Envio with root .env aliases bridged to ENVIO_* keys (batch size, start block, RPC).
 * The arb bot does the same via `buildHyperIndexChildEnv`; this wrapper covers standalone runs.
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { applyHyperSyncPacingEnv } from "../src/utils/pacing.ts";

const ROOT = path.resolve(import.meta.dir, "..");
const subcommand = process.argv[2] ?? "dev";

const env: Record<string, string | undefined> = { ...process.env };
applyHyperSyncPacingEnv(env);

const child = spawn("envio", [subcommand], {
  cwd: ROOT,
  env: env as NodeJS.ProcessEnv,
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 1));
