#!/usr/bin/env bun
/**
 * Start Envio with root .env aliases bridged to ENVIO_* keys (batch size, start block, RPC).
 * The arb bot does the same via `buildHyperIndexChildEnv`; this wrapper covers standalone runs.
 *
 * On startup, kills any other instance of this indexer (and its process tree) for this repo.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const ROOT = path.resolve(import.meta.dir, "..");
const SELF_PID = process.pid;
const ENVIO_BIN = path.resolve(ROOT, "node_modules/.bin/envio");
const ENVIO_BIN_MJS = path.resolve(ROOT, "node_modules/envio/bin.mjs");
const ENVIO_DEV_SCRIPT = path.resolve(ROOT, "scripts/envio-dev.ts");

const raw = process.argv.slice(2);
const subcommand = raw[0]?.startsWith("-") ? "dev" : raw[0] ?? "dev";
const extraArgs = raw[0]?.startsWith("-") ? raw : raw.slice(1);

const env: Record<string, string | undefined> = { ...process.env };
// ponytail: bridge root .env aliases (RPC, start block) to Envio-prefixed vars
if (env.POLYGON_START_BLOCK && !env.ENVIO_POLYGON_START_BLOCK) env.ENVIO_POLYGON_START_BLOCK = env.POLYGON_START_BLOCK;
if (env.POLYGON_RPC_URLS && !env.ENVIO_POLYGON_RPC_URLS) env.ENVIO_POLYGON_RPC_URLS = env.POLYGON_RPC_URLS;
if (env.POLYGON_RPC_URL && !env.ENVIO_POLYGON_RPC_URL) env.ENVIO_POLYGON_RPC_URL = env.POLYGON_RPC_URL;

// Historical Polygon backfill exceeds Node's default ~4GB heap; host has headroom.
const heapMb = Number(env.ENVIO_NODE_MAX_OLD_SPACE_MB ?? "8192");
if (Number.isFinite(heapMb) && heapMb > 0) {
  const flag = `--max-old-space-size=${Math.floor(heapMb)}`;
  env.NODE_OPTIONS = env.NODE_OPTIONS?.includes("max-old-space-size")
    ? env.NODE_OPTIONS
    : [env.NODE_OPTIONS, flag].filter(Boolean).join(" ");
}

// --- singleton: kill other instances of this repo's indexer ---

/** Null-separated /proc cmdline → argv parts (avoids matching paths buried in shell -c strings). */
function readArgv(pid: number): string[] {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

function readCwd(pid: number): string {
  try {
    return fs.readlinkSync(`/proc/${pid}/cwd`);
  } catch {
    return "";
  }
}

/** /proc/<pid>/stat field 4 is ppid; comm may contain spaces/parens. */
function readPpid(pid: number): number {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
    const closeParen = stat.lastIndexOf(")");
    if (closeParen < 0) return 0;
    const fields = stat.slice(closeParen + 2).split(" ");
    return Number(fields[1]) || 0;
  } catch {
    return 0;
  }
}

function listPids(): number[] {
  return fs
    .readdirSync("/proc")
    .filter((name) => /^\d+$/.test(name))
    .map(Number);
}

function cwdInRoot(cwd: string): boolean {
  return cwd === ROOT || cwd.startsWith(`${ROOT}${path.sep}`);
}

function isJsRuntime(argv0: string): boolean {
  const base = path.basename(argv0);
  return base === "bun" || base === "node" || base === "nodejs";
}

/** Launcher script arg for *this* checkout only. */
function isEnvioDevScriptArg(arg: string, cwd: string): boolean {
  if (arg === ENVIO_DEV_SCRIPT) return true;
  if (arg === "scripts/envio-dev.ts" && cwdInRoot(cwd)) return true;
  if (
    arg.endsWith("/scripts/envio-dev.ts") &&
    (arg.startsWith(`${ROOT}${path.sep}`) || cwdInRoot(cwd))
  ) {
    return true;
  }
  return false;
}

/** Envio binary arg for *this* checkout only. */
function isThisRepoEnvioBin(arg: string, cwd: string): boolean {
  if (arg === ENVIO_BIN || arg === ENVIO_BIN_MJS) return true;
  if (arg.startsWith(`${ROOT}${path.sep}`)) {
    return arg.endsWith("/node_modules/.bin/envio") || arg.endsWith("/node_modules/envio/bin.mjs");
  }
  if (!cwdInRoot(cwd)) return false;
  return (
    arg === "node_modules/.bin/envio" ||
    arg === "node_modules/envio/bin.mjs" ||
    arg === "./node_modules/.bin/envio" ||
    arg === "./node_modules/envio/bin.mjs"
  );
}

/**
 * True if PID is an indexer process for this checkout (not us).
 * Requires the script/bin path as its own argv element so editors, shells, and
 * greps that merely mention the path are not killed.
 */
function isThisRepoIndexer(pid: number): boolean {
  if (pid === SELF_PID) return false;
  const argv = readArgv(pid);
  if (argv.length === 0) return false;
  const argv0 = argv[0] ?? "";
  const cwd = readCwd(pid);

  // bun/node running scripts/envio-dev.ts, or the script as argv0
  if (argv.some((a) => isEnvioDevScriptArg(a, cwd))) {
    if (isEnvioDevScriptArg(argv0, cwd) || isJsRuntime(argv0)) return true;
  }

  // This repo's envio binary
  if (argv.some((a) => isThisRepoEnvioBin(a, cwd))) {
    if (isThisRepoEnvioBin(argv0, cwd) || isJsRuntime(argv0)) return true;
  }

  // bare `envio dev|run` with cwd in this repo
  if (cwdInRoot(cwd)) {
    const base0 = path.basename(argv0);
    if (base0 === "envio" && argv.some((a) => a === "dev" || a === "run")) return true;
  }

  return false;
}

function collectDescendants(rootPid: number, childrenByPpid: Map<number, number[]>): number[] {
  const out: number[] = [];
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop()!;
    const kids = childrenByPpid.get(pid);
    if (!kids) continue;
    for (const child of kids) {
      out.push(child);
      stack.push(child);
    }
  }
  return out;
}

/** Numeric signals — Bun can mishandle named signal strings for non-child PIDs. */
function signalPid(pid: number, signal: number): boolean {
  try {
    process.kill(pid, signal);
    return true;
  } catch {
    return false;
  }
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function killOtherIndexerInstances(): Promise<void> {
  const allPids = listPids();
  const roots = allPids.filter(isThisRepoIndexer);
  if (roots.length === 0) return;

  const childrenByPpid = new Map<number, number[]>();
  for (const pid of allPids) {
    if (pid === SELF_PID) continue;
    const ppid = readPpid(pid);
    let list = childrenByPpid.get(ppid);
    if (!list) {
      list = [];
      childrenByPpid.set(ppid, list);
    }
    list.push(pid);
  }

  const killSet = new Set<number>();
  for (const root of roots) {
    killSet.add(root);
    for (const d of collectDescendants(root, childrenByPpid)) killSet.add(d);
  }
  killSet.delete(SELF_PID);

  const targets = [...killSet].filter(isAlive);
  if (targets.length === 0) return;

  // Descendants before roots
  const ordered: number[] = [];
  const seen = new Set<number>();
  for (const root of roots) {
    if (!killSet.has(root)) continue;
    const desc = collectDescendants(root, childrenByPpid).filter((p) => killSet.has(p));
    for (let i = desc.length - 1; i >= 0; i--) {
      const p = desc[i]!;
      if (!seen.has(p)) {
        seen.add(p);
        ordered.push(p);
      }
    }
    if (!seen.has(root)) {
      seen.add(root);
      ordered.push(root);
    }
  }
  for (const p of targets) {
    if (!seen.has(p)) ordered.push(p);
  }

  console.error(
    `[envio-dev] found ${ordered.length} other indexer process(es); sending SIGTERM: ${ordered.join(", ")}`,
  );
  for (const pid of ordered) signalPid(pid, 15); // SIGTERM

  const graceMs = Number(env.ENVIO_KILL_GRACE_MS ?? "2000");
  await sleep(Number.isFinite(graceMs) && graceMs > 0 ? graceMs : 2000);

  const stubborn = ordered.filter(isAlive);
  if (stubborn.length > 0) {
    console.error(`[envio-dev] SIGKILL still-running: ${stubborn.join(", ")}`);
    for (const pid of stubborn) signalPid(pid, 9); // SIGKILL
    await sleep(200);
  }
}

await killOtherIndexerInstances();

const child = spawn(ENVIO_BIN, [subcommand, ...extraArgs], {
  cwd: ROOT,
  env: env as NodeJS.ProcessEnv,
  stdio: "inherit",
});

child.on("close", (code) => process.exit(code ?? 1));
