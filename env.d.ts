declare namespace NodeJS {
  interface ProcessEnv {
    POLYGON_RPC_URLS?: string;
    POLYGON_RPC_URL?: string;
    POLYGON_RPC?: string;
    ENVIO_POLYGON_RPC_URLS?: string;
    ENVIO_POLYGON_RPC_URL?: string;
    POLYGON_START_BLOCK?: string;
    ENVIO_POLYGON_START_BLOCK?: string;
    TOKEN_REGISTRY_DB?: string;
    HYPERSYNC_RPM_TARGET?: string;
    ENVIO_HYPERSYNC_RPM_TARGET?: string;
    HYPERSYNC_MAX_RPM_PER_TOKEN?: string;
    ENVIO_FULL_BATCH_SIZE?: string;
    VITEST?: string;
    ENVIO_LOG_LEVEL?: string;
    HYPER_SYNC_URL?: string;
    ENVIO_POLYGON_HYPERSYNC_URL?: string;
    INDEXER_PROGRESS_REALTIME_START?: string;
    ENVIO_INDEXER_PROGRESS_REALTIME_START?: string;
    INDEXER_PROGRESS_HISTORICAL_EVERY?: string;
    INDEXER_PROGRESS_REALTIME_EVERY?: string;
    POOLS_JSON?: string;
  }
}

// Bun runtime adds `import.meta.dir` — not in standard TypeScript lib.
interface ImportMeta {
  dir: string | undefined;
}

// Bun built-in sqlite module (loaded via dynamic import for Bun-only path).
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    prepare(sql: string): { all<T = Record<string, unknown>>(): T[] };
    close(): void;
  }
}
