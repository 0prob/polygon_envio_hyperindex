declare namespace NodeJS {
  interface ProcessEnv {
    // RPC (rpc_client.ts resolution order)
    ENVIO_POLYGON_RPC_URLS?: string;
    ENVIO_POLYGON_RPC_URL?: string;
    POLYGON_RPC_URLS?: string;
    POLYGON_RPC_URL?: string;
    POLYGON_RPC?: string;

    // Start block (constants.ts + config.yaml; envio-dev bridges POLYGON_* → ENVIO_*)
    ENVIO_POLYGON_START_BLOCK?: string;
    POLYGON_START_BLOCK?: string;

    // HyperSync / Envio (config.yaml interpolation + Envio runtime)
    ENVIO_API_TOKEN?: string;
    ENVIO_POLYGON_HYPERSYNC_URL?: string;
    ENVIO_FULL_BATCH_SIZE?: string;
    ENVIO_LOG_LEVEL?: string;

    // Indexer progress strides (progress.ts)
    INDEXER_PROGRESS_REALTIME_START?: string;
    INDEXER_PROGRESS_HISTORICAL_EVERY?: string;
    INDEXER_PROGRESS_REALTIME_EVERY?: string;

    // Balancer repair onBlock (balancer.ts)
    BALANCER_POOLTYPE_REPAIR_EVERY?: string;
    BALANCER_POOLTYPE_REPAIR_BATCH?: string;
    BALANCER_POOLTYPE_REPAIR_START?: string;

    // Algebra repair onBlock (algebra_factory.ts)
    ALGEBRA_META_REPAIR_EVERY?: string;
    ALGEBRA_META_REPAIR_BATCH?: string;
    ALGEBRA_META_REPAIR_START?: string;

    // DODO fee repair onBlock (dodo_factory.ts)
    DODO_FEE_REPAIR_EVERY?: string;
    DODO_FEE_REPAIR_BATCH?: string;
    DODO_FEE_REPAIR_START?: string;

    // Paths
    TOKEN_REGISTRY_DB?: string;
    POOLS_JSON?: string;

    // envio-dev.ts
    ENVIO_NODE_MAX_OLD_SPACE_MB?: string;
    ENVIO_KILL_GRACE_MS?: string;
    NODE_OPTIONS?: string;

    // migrate-db / backup-db / repair-balancer-pooltype
    PG_URL?: string;
    ENVIO_PG_URL?: string;
    DATABASE_URL?: string;
    ENVIO_POSTGRES_HOST?: string;
    ENVIO_POSTGRES_PORT?: string;
    ENVIO_POSTGRES_USER?: string;
    ENVIO_POSTGRES_PASSWORD?: string;
    ENVIO_POSTGRES_DB?: string;
    ENVIO_POSTGRES_CONTAINER?: string;
    BACKUP_DIR?: string;

    // Curve bootstrap gate (curve_bootstrap.ts)
    CURVE_BOOTSTRAP_FROM_BLOCK?: string;
    CURVE_BOOTSTRAP_EVERY?: string;
    CURVE_BOOTSTRAP_GROWTH_EVERY?: string;
    CURVE_BOOTSTRAP_POOLS_PER_FIRE?: string;

    // HyperSync factory-event recon (factory_event_reconciliation.ts)
    FACTORY_EVENT_RECONCILIATION_FROM_BLOCK?: string;
    FACTORY_EVENT_RECONCILIATION_EVERY?: string;
    FACTORY_EVENT_RECONCILIATION_PAGES?: string;

    // V2 allPairs recon — opt-in via FROM_BLOCK (v2_reconciliation.ts)
    V2_RECONCILIATION_FROM_BLOCK?: string;
    V2_RECONCILIATION_EVERY?: string;

    // Forced false by scripts/envio-dev.ts; also set in vitest.config.ts
    ENVIO_HASURA?: string;
  }
}

// Bun runtime adds `import.meta.dir` — not in standard TypeScript lib.
interface ImportMeta {
  dir: string | undefined;
}

/** Minimal Bun globals used by scripts (avoid full @types/bun). */
declare const Bun: {
  file(path: string): { text(): Promise<string> };
};

// Bun built-in sqlite module (loaded via dynamic import for Bun-only path).
declare module "bun:sqlite" {
  export class Database {
    constructor(path: string, options?: { readonly?: boolean });
    prepare(sql: string): {
      all<T = Record<string, unknown>>(...params: unknown[]): T[];
      run(...params: unknown[]): unknown;
    };
    run(sql: string, ...params: unknown[]): unknown;
    transaction<T extends (...args: never[]) => unknown>(fn: T): T;
    close(): void;
  }
}
