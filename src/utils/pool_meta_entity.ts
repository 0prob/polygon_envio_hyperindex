/** Defaults optional PoolMeta GraphQL fields omitted by most protocol handlers. */
export function poolMetaEntity<T extends Record<string, unknown>>(
  fields: T,
): T & { hooks: undefined; poolType: string | undefined } {
  return {
    hooks: undefined,
    poolType: undefined,
    ...fields,
  };
}
