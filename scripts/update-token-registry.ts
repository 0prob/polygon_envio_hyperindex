#!/usr/bin/env bun
/**
 * Convenience script to regenerate the token registry with all sources
 * (public lists + bot pools + runtime discoveries + auto-extra tokens)
 * and safely write it into place.
 *
 * Usage:
 *   bun run generate-tokens:auto
 *   (called automatically by the bot's HyperIndex process wrapper on shutdown for self-updating)
 */

import { spawn } from "child_process";
import { writeFile, rename } from "node:fs/promises";
import path from "node:path";

const ROOT = path.resolve(import.meta.dir, "..");
const TARGET_FILE = path.resolve(ROOT, "src/effects/token_registry.ts");
const TMP_FILE = TARGET_FILE + ".tmp";

async function main() {
  console.log("🔄 Regenerating STATIC_TOKEN_DECIMALS with full sources...\n");

  const generator = spawn("bun", ["scripts/generate-polygon-tokens.ts"], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";

  generator.stdout.on("data", (data) => {
    stdout += data.toString();
  });

  generator.stderr.on("data", (data) => {
    stderr += data.toString();
  });

  const code = await new Promise<number>((resolve) => {
    generator.on("close", (code) => resolve(code ?? 1));
  });

  if (code !== 0) {
    console.error("❌ Generator failed:");
    console.error(stderr);
    process.exit(code);
  }

  // The generator prints the file content to stdout and stats to stderr
  await writeFile(TMP_FILE, stdout, "utf8");

  // Atomic move
  await rename(TMP_FILE, TARGET_FILE);

  // Extract total from stderr
  const match = stderr.match(/Total unique tokens:\s*(\d+)/);
  const total = match ? match[1] : "unknown";

  console.log(`✅ Token registry updated successfully!`);
  console.log(`   Total unique tokens: ${total}`);
  console.log(`   Written to: src/effects/token_registry.ts\n`);

  // Show any useful stderr output (fetch counts)
  const fetchLines = stderr
    .split("\n")
    .filter((l) => l.includes("Fetched") || l.includes("Loaded"))
    .join("\n");

  if (fetchLines) {
    console.log("Sources loaded:");
    console.log(fetchLines);
  }
}

main().catch((err) => {
  console.error("❌ Failed to update token registry:", err);
  process.exit(1);
});
