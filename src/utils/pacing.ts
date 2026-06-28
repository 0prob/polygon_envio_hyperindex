/**
 * Central pacing / quota awareness for the HyperIndex side.
 *
 * Primary goal: when running on free-tier HyperSync tokens (~200 rpm hard limit),
 * coordinate batch sizes, effect concurrency, and onBlock frequency so we stay
 * close to (but under) the limit without triggering long server backoffs.
 *
 * The single source of truth is HYPERSYNC_RPM_TARGET (falls back to 180 for safety
 * when the bot launches us, or 200 if someone runs `envio dev` directly).
 */

export function parseRpmTarget(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return Math.floor(n);
  return undefined;
}

function rpmFromEnv(env: Record<string, string | undefined>): number {
  return (
    parseRpmTarget(env.ENVIO_HYPERSYNC_RPM_TARGET) ??
    parseRpmTarget(env.HYPERSYNC_RPM_TARGET) ??
    parseRpmTarget(env.HYPERSYNC_MAX_RPM_PER_TOKEN) ??
    180
  );
}

/** Apply HyperSync pacing knobs to a child-process env (batch size + rpm aliases). */
export function applyHyperSyncPacingEnv(env: Record<string, string | undefined>): void {
  bridgeIndexerEnvAliases(env);
  const rpm = rpmFromEnv(env);
  env.ENVIO_HYPERSYNC_RPM_TARGET = String(rpm);
  env.HYPERSYNC_RPM_TARGET = env.HYPERSYNC_RPM_TARGET ?? String(rpm);
  if (!env.ENVIO_FULL_BATCH_SIZE) {
    env.ENVIO_FULL_BATCH_SIZE = String(getRecommendedFullBatchSizeForRpm(rpm));
  }
}

function getRecommendedFullBatchSizeForRpm(rpm: number): number {
  if (rpm >= 180) return 6000;
  if (rpm >= 150) return 2800;
  if (rpm >= 120) return 1800;
  return 1000;
}

export function getRpmTarget(): number {
  return rpmFromEnv(process.env as Record<string, string | undefined>);
}

export function isLowQuota(): boolean {
  return getRpmTarget() < 150;
}

export function isVeryLowQuota(): boolean {
  return getRpmTarget() < 120;
}

/**
 * Max concurrent metadata effect calls (token + curve/balancer/dodo) per handler.
 * Raw Promise.all on a burst of PairCreated events is the easiest way to create
 * request spikes that interact badly with a tight HyperSync budget.
 */
export function getMetadataConcurrency(): number {
  const rpm = getRpmTarget();
  // Keep low during backfill bursts — each handler fans out to multiple RPC effects.
  if (rpm >= 180) return 3;
  if (rpm >= 150) return 2;
  if (rpm >= 120) return 2;
  return 1;
}

/**
 * Effect rateLimit for fetchTokenMeta — latest-state, single cheap read,
 * multicall-batched. This is the most frequently invoked metadata effect
 * (every new pool references two tokens), but the vast majority resolve from
 * the in-memory/static registry, so only genuinely-cold tokens hit RPC.
 *
 * Scales down on tight HyperSync quotas. The previous 500/s ceiling let bursts
 * of cold-token reads saturate the (typically 2–3 endpoint) RPC pool and
 * trigger timeouts/5xx; these ceilings are intentionally conservative.
 */
export function getTokenMetaEffectRateLimit(): { calls: number; per: "second" } {
  const rpm = getRpmTarget();
  if (rpm >= 180) return { calls: 250, per: "second" };
  if (rpm >= 150) return { calls: 150, per: "second" };
  if (rpm >= 120) return { calls: 80, per: "second" };
  return { calls: 40, per: "second" };
}

/**
 * Effect rateLimit for block-pinned metadata reads (DODO, Balancer).
 *
 * These read pool state at a specific historical block (archive eth_call),
 * which is far heavier server-side than latest-state token decimals, so they
 * get a tighter budget. Unlike before, this scales with HyperSync quota — a
 * low-quota launch now actually throttles these instead of always allowing the
 * old hardcoded 100–150/s.
 */
export function getHistoricalMetaEffectRateLimit(): { calls: number; per: "second" } {
  const rpm = getRpmTarget();
  if (rpm >= 180) return { calls: 60, per: "second" };
  if (rpm >= 150) return { calls: 40, per: "second" };
  if (rpm >= 120) return { calls: 25, per: "second" };
  return { calls: 12, per: "second" };
}

/**
 * Effect rateLimit for Curve discovery metadata (fee + gamma + nCoins coin reads,
 * block-pinned). Lighter than the old full-state fetch but still archive-bound.
 */
export function getCurveMetaEffectRateLimit(): { calls: number; per: "second" } {
  const rpm = getRpmTarget();
  if (rpm >= 180) return { calls: 25, per: "second" };
  if (rpm >= 150) return { calls: 16, per: "second" };
  if (rpm >= 120) return { calls: 10, per: "second" };
  return { calls: 5, per: "second" };
}

/**
 * For onBlock handlers (currently only IndexerProgress).
 * On very tight quotas we can afford to be less chatty about progress.
 */
export function getProgressOnBlockStride(defaultStride: number): number {
  if (isVeryLowQuota()) return Math.max(defaultStride, 500);
  if (isLowQuota()) return Math.max(defaultStride, 300);
  return defaultStride;
}

/**
 * Run an array of async tasks with limited concurrency.
 * Used in factory handlers to avoid request spikes on bursts of PairCreated/PoolCreated
 * when HYPERSYNC_RPM_TARGET is low.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[] | T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  if (limit <= 1) {
    const results: R[] = new Array(items.length);
    for (let i = 0; i < items.length; i++) {
      results[i] = await fn(items[i], i);
    }
    return results;
  }

  const concurrency = Math.min(limit, items.length);
  const results: R[] = new Array(items.length);
  let next = 0;

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i], i);
      }
    }),
  );
  return results;
}

/**
 * Bridge root .env aliases to Envio-prefixed vars expected by config.yaml and handlers.
 * Safe to call multiple times; only fills missing keys.
 */
export function bridgeIndexerEnvAliases(env: Record<string, string | undefined>): void {
  if (env.POLYGON_START_BLOCK && !env.ENVIO_POLYGON_START_BLOCK) {
    env.ENVIO_POLYGON_START_BLOCK = env.POLYGON_START_BLOCK;
  }
  if (env.ENVIO_POLYGON_START_BLOCK && !env.POLYGON_START_BLOCK) {
    env.POLYGON_START_BLOCK = env.ENVIO_POLYGON_START_BLOCK;
  }

  // RPC URLs — root .env uses POLYGON_RPC_* aliases; config.yaml uses ENVIO_POLYGON_RPC_*.
  if (env.POLYGON_RPC_URLS && !env.ENVIO_POLYGON_RPC_URLS) {
    env.ENVIO_POLYGON_RPC_URLS = env.POLYGON_RPC_URLS;
  }
  if (env.ENVIO_POLYGON_RPC_URLS && !env.POLYGON_RPC_URLS) {
    env.POLYGON_RPC_URLS = env.ENVIO_POLYGON_RPC_URLS;
  }
  if (env.POLYGON_RPC_URL && !env.ENVIO_POLYGON_RPC_URL) {
    env.ENVIO_POLYGON_RPC_URL = env.POLYGON_RPC_URL;
  }
  if (env.ENVIO_POLYGON_RPC_URL && !env.POLYGON_RPC_URL) {
    env.POLYGON_RPC_URL = env.ENVIO_POLYGON_RPC_URL;
  }
  if (env.POLYGON_RPC && !env.POLYGON_RPC_URL && !env.POLYGON_RPC_URLS) {
    env.POLYGON_RPC_URL = env.POLYGON_RPC;
  }
  if (env.ALCHEMY_API_KEY && !env.ENVIO_ALCHEMY_API_KEY) {
    env.ENVIO_ALCHEMY_API_KEY = env.ALCHEMY_API_KEY;
  }
  if (env.ENVIO_ALCHEMY_API_KEY && !env.ALCHEMY_API_KEY) {
    env.ALCHEMY_API_KEY = env.ENVIO_ALCHEMY_API_KEY;
  }

  if (env.HYPER_SYNC_URL && !env.ENVIO_POLYGON_HYPERSYNC_URL) {
    env.ENVIO_POLYGON_HYPERSYNC_URL = env.HYPER_SYNC_URL;
  }
  if (env.ENVIO_POLYGON_HYPERSYNC_URL && !env.HYPER_SYNC_URL) {
    env.HYPER_SYNC_URL = env.ENVIO_POLYGON_HYPERSYNC_URL;
  }

  const rpm =
    env.ENVIO_HYPERSYNC_RPM_TARGET || env.HYPERSYNC_RPM_TARGET || env.HYPERSYNC_MAX_RPM_PER_TOKEN;
  if (rpm) {
    env.ENVIO_HYPERSYNC_RPM_TARGET ??= rpm;
    env.HYPERSYNC_RPM_TARGET ??= rpm;
    env.HYPERSYNC_MAX_RPM_PER_TOKEN ??= rpm;
  }
}
