declare namespace NodeJS {
  interface ProcessEnv {
    POLYGON_RPC_URLS?: string;
    POLYGON_RPC_URL?: string;
    POLYGON_RPC?: string;
    ENVIO_POLYGON_RPC_URLS?: string;
    ENVIO_POLYGON_RPC_URL?: string;
    ALCHEMY_API_KEY?: string;
    ENVIO_ALCHEMY_API_KEY?: string;
    POLYGON_START_BLOCK?: string;
    HYPERSYNC_RPM_TARGET?: string;
    INDEXER_HOT_BIAS?: string;
    VITEST?: string;
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
