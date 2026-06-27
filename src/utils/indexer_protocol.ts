/** Mirrors schema.graphql Protocol enum — keep in sync with PoolMeta.protocol. */
export type IndexerProtocol =
  | "UNISWAP_V2"
  | "SUSHISWAP_V2"
  | "QUICKSWAP_V2"
  | "DFYN_V2"
  | "APESWAP_V2"
  | "MESHSWAP_V2"
  | "JETSWAP_V2"
  | "COMETHSWAP_V2"
  | "UNISWAP_V3"
  | "SUSHISWAP_V3"
  | "QUICKSWAP_V3"
  | "KYBERSWAP_ELASTIC"
  | "RAMSES_V3"
  | "CURVE"
  | "BALANCER_V2"
  | "DODO_V2"
  | "UNISWAP_V4"
  | "WOOFI";

/** Shape accepted by Envio PoolMeta.set — optional GraphQL fields are required keys. */
export type PoolMetaWritePayload = {
  readonly id: string;
  readonly address: string;
  readonly protocol: IndexerProtocol;
  readonly tokens: readonly string[];
  readonly fee: number | undefined;
  readonly tickSpacing: number | undefined;
  readonly createdBlock: number;
  readonly updatedAtBlock: number;
  readonly poolId: string | undefined;
  readonly hooks: string | undefined;
  readonly poolType: string | undefined;
};
