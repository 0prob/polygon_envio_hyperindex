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
