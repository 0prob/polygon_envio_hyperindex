import { createPublicClient, http, fallback, type PublicClient, type HttpTransport } from "viem";
import { polygon } from "viem/chains";
// ponytail: polygon is used by publicClient context below

/**
 * Centralized RPC client for all effects (token decimals, Curve/Balancer/DODO metadata, etc.).
 *
 * Supports comma-separated POLYGON_RPC_URLS (preferred) or POLYGON_RPC_URL from .env.
 * .env endpoints are used with viem fallback(). Public fallbacks are appended as
 * secondary endpoints when the user provides fewer than 3 endpoints.
 *
 * Recommended: paid archival providers for historical eth_call volume + multicall.
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
export function getRpcUrls(): string[] {
  for (const key of RPC_ENV_KEYS) {
    const raw = process.env[key];
    if (!raw) continue;
    const list = [...new Set(raw.split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
    if (list.length > 0) {
      // ponytail: append public fallbacks when user has < 3 endpoints — a single
      // paid endpoint still hits quota under heavy archival eth_call volume
      // (Balancer/DODO/Curve/WooFi bootstrapping). viem fallback() ranks the
      // user's endpoints first, so fallbacks only serve during rate-limit bursts.
      const fallbacks = PUBLIC_FALLBACK_RPC_URLS.filter((u) => !list.includes(u));
      return [...list, ...fallbacks];
    }
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

export function getRpcTransportTuning(): RpcTransportTuning {
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

let publicClientInstance: PublicClient | undefined;

function buildHttpTransport(url: string, tuning: RpcTransportTuning): HttpTransport {
  // IMPORTANT: Do NOT set `Connection` / `Keep-Alive` request headers here.
  // They are forbidden header names per the fetch spec. Node's undici (the fetch
  // impl used by the envio indexer runtime) fails the request entirely when they
  // are present ("HTTP request failed"), so every effect RPC call (Balancer/DODO
  // metadata, token decimals) timed out under node. Bun's fetch silently ignores
  // them, which is why this only broke in the live indexer and not in tests/scripts.
  // HTTP keep-alive is already handled automatically by undici's connection pool.
  return http(url, {
    batch: {
      batchSize: tuning.httpBatchSize,
      wait: tuning.httpBatchWait,
    },
    timeout: tuning.timeoutMs,
    retryCount: tuning.retryCount,
    retryDelay: tuning.retryDelayMs,
  });
}

export function buildPublicClient(): PublicClient {
  const rpcUrls = getRpcUrls();
  const tuning = getRpcTransportTuning();

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

