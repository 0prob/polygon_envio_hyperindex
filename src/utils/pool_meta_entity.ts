/** Defaults optional PoolMeta GraphQL fields omitted by most protocol handlers. */
export function poolMetaEntity<T extends Record<string, unknown>>(
  fields: T,
): T & { hooks: string | undefined; poolType: string | undefined; specialization: number | undefined } {
  return {
    hooks: undefined,
    poolType: undefined,
    specialization: undefined,
    ...fields,
  };
}
