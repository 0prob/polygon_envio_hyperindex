import { createPublicClient, http, fallback, type PublicClient, type HttpTransport } from "viem";
import { polygon } from "viem/chains";
import { getRpmTarget } from "../utils/pacing";

/**
 * Centralized RPC client for all effects (token decimals, Curve/Balancer/DODO metadata, etc.).
 *
 * Supports comma-separated POLYGON_RPC_URLS (preferred) or POLYGON_RPC_URL from .env.
 * .env endpoints (after archival probe filtering upstream) are used with viem fallback().
 * Only falls back to public RPCs (no embedded keys) when nothing usable was provided.
 *
 * The effect rateLimits (in the metadata effects) are now raised for pay-as-you-go
 * Alchemy. The batch + multicall settings here keep the actual HTTP request rate
 * much lower than the effect invocation rate.
 *
 * Recommended:
 *   1. Alchemy pay-as-you-go (best for historical eth_call volume + multicall)
 *   2. Other paid archival providers
 *   3. Free public as last resort only
 */

/** Public fallbacks — only when no configured RPC URLs exist. Rate-limited and often non-archival. */
export const PUBLIC_FALLBACK_RPC_URLS = [
  "https://polygon.drpc.org",
  "https://polygon-mainnet.public.blastapi.io",
  "https://polygon.api.onfinality.io/public",
] as const;

const RPC_ENV_KEYS = [
  "ENVIO_POLYGON_RPC_URLS",
  "ENVIO_POLYGON_RPC_URL",
  "POLYGON_RPC_URLS",
  "POLYGON_RPC_URL",
  "POLYGON_RPC",
] as const;

/** Parse comma/semicolon/whitespace-separated RPC URLs, deduped in order. */
export function parseRpcUrlList(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const url = part.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out;
}

/** Redact API keys from RPC URLs before logging. */
export function redactRpcUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/");
    const keySlot = segments.length - 1;
    const prev = segments[keySlot - 1];
    if (keySlot > 0 && (prev === "v2" || prev === "v3" || prev === "v4")) {
      segments[keySlot] = "***";
      parsed.pathname = segments.join("/");
    }
    for (const param of ["apiKey", "apikey", "key", "token"]) {
      if (parsed.searchParams.has(param)) {
        parsed.searchParams.set(param, "***");
      }
    }
    return parsed.toString();
  } catch {
    return url.replace(/\/[A-Za-z0-9_-]{16,}(?=\/|$)/g, "/***");
  }
}

function getAlchemyApiKey(): string | undefined {
  const key = (process.env.ENVIO_ALCHEMY_API_KEY || process.env.ALCHEMY_API_KEY || "").trim();
  return key.length > 0 ? key : undefined;
}

export function getRpcUrls(): string[] {
  for (const key of RPC_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    const list = parseRpcUrlList(raw);
    if (list.length > 0) return list;
  }
  return [...PUBLIC_FALLBACK_RPC_URLS];
}

interface RpcTransportTuning {
  httpBatchSize: number;
  httpBatchWait: number;
  multicallBatchSize: number;
  multicallWait: number;
  timeoutMs: number;
  retryCount: number;
  retryDelayMs: number;
}

/** Scale HTTP + multicall batching with HyperSync quota — tighter budgets get smaller bursts. */
export function getRpcTransportTuning(rpm = getRpmTarget()): RpcTransportTuning {
  if (rpm >= 180) {
    return {
      httpBatchSize: 8,
      httpBatchWait: 16,
      multicallBatchSize: 64,
      multicallWait: 16,
      timeoutMs: 12_000,
      retryCount: 2,
      retryDelayMs: 400,
    };
  }
  if (rpm >= 150) {
    return {
      httpBatchSize: 12,
      httpBatchWait: 24,
      multicallBatchSize: 48,
      multicallWait: 24,
      timeoutMs: 15_000,
      retryCount: 2,
      retryDelayMs: 500,
    };
  }
  return {
    httpBatchSize: 8,
    httpBatchWait: 32,
    multicallBatchSize: 32,
    multicallWait: 32,
    timeoutMs: 15_000,
    retryCount: 3,
    retryDelayMs: 500,
  };
}

let publicClientInstance: PublicClient | undefined;

function buildHttpTransport(url: string, tuning: RpcTransportTuning): HttpTransport {
  // IMPORTANT: Do NOT set `Connection` / `Keep-Alive` request headers here.
  // They are forbidden header names per the fetch spec. Node's undici (the fetch
  // impl used by the envio indexer runtime) fails the request entirely when they
  // are present ("HTTP request failed"), so every effect RPC call (Balancer/DODO
  // metadata, token decimals) timed out under node. Bun's fetch silently ignores
  // them, which is why this only broke in the live indexer and not in tests/scripts.
  // HTTP keep-alive is already handled automatically by undici's connection pool.
  const headers: Record<string, string> = {};
  const alchemyKey = getAlchemyApiKey();
  if (alchemyKey && url.includes("alchemy")) {
    headers["X-Alchemy-Token"] = alchemyKey;
  }

  return http(url, {
    batch: {
      batchSize: tuning.httpBatchSize,
      wait: tuning.httpBatchWait,
    },
    timeout: tuning.timeoutMs,
    retryCount: tuning.retryCount,
    retryDelay: tuning.retryDelayMs,
    ...(Object.keys(headers).length > 0 ? { fetchOptions: { headers } } : {}),
  });
}

export function buildPublicClient(): PublicClient {
  const rpcUrls = getRpcUrls();
  const tuning = getRpcTransportTuning();
  const usingFallbacks = rpcUrls.every((url) =>
    (PUBLIC_FALLBACK_RPC_URLS as readonly string[]).includes(url),
  );

  if (process.env.VITEST !== "true") {
    console.log(
      JSON.stringify({
        level: 30,
        msg: "rpc_client_init",
        endpointCount: rpcUrls.length,
        endpoints: rpcUrls.map(redactRpcUrl),
        usingPublicFallbacks: usingFallbacks,
        rpmTarget: getRpmTarget(),
        httpBatchSize: tuning.httpBatchSize,
        multicallBatchSize: tuning.multicallBatchSize,
      }),
    );
    if (usingFallbacks) {
      console.warn(
        "[rpc_client] No POLYGON_RPC_URLS configured — using public fallbacks. " +
          "Add paid archival endpoints to .env for reliable historical eth_call in effects.",
      );
    }
  }

  const transports = rpcUrls.map((url) => buildHttpTransport(url, tuning));
  const transport =
    transports.length > 1
      ? fallback(transports, {
          rank: true,
          retryCount: tuning.retryCount,
          retryDelay: tuning.retryDelayMs,
        })
      : transports[0];

  return createPublicClient({
    chain: polygon,
    transport,
    batch: {
      multicall: {
        batchSize: tuning.multicallBatchSize,
        wait: tuning.multicallWait,
      },
    },
  });
}

/** Lazy client — avoids RPC setup during Vitest handler runs that only hit the static registry. */
export const publicClient: PublicClient = new Proxy({} as PublicClient, {
  get(_target, prop, receiver) {
    if (!publicClientInstance) {
      publicClientInstance = buildPublicClient();
    }
    const value = Reflect.get(publicClientInstance, prop, receiver);
    return typeof value === "function" ? value.bind(publicClientInstance) : value;
  },
});

/** @internal Vitest-only — rebuild client after env changes between cases. */
export function resetPublicClientForTest(): void {
  if (process.env.VITEST !== "true") return;
  publicClientInstance = undefined;
}

/** Lightweight RPC error classification (mirrors bot retry.ts). */
export function isQuotaError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("monthly") ||
    msg.includes("capacity") ||
    msg.includes("quota") ||
    msg.includes("429") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests")
  );
}

export function isNetworkError(err: unknown): boolean {
  const msg = String(err).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("timed out") ||
    msg.includes("failed to fetch") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("socket hang up") ||
    msg.includes("http request failed") ||
    /\b50[0-9]\b/.test(msg)
  );
}

// Re-export for convenience in effects
export { polygon };
