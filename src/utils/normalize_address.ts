/** Lowercase 20-byte address; left-pads short 0x-prefixed hex for registry/Hasura keys. */
const HEX_LOWERCASE_RE = /^0x[0-9a-f]{40}$/;

export function normalizeTokenAddress(address: string): string {
  // Fast-path: when address_format: lowercase is configured (our setup), all inputs are
  // already lowercase. Skip the allocation for the hot path (99.9% of calls during backfill).
  if (HEX_LOWERCASE_RE.test(address)) return address;
  let addr = address;
  for (let i = 0; i < addr.length; i++) {
    const c = addr.charCodeAt(i);
    if (c >= 65 && c <= 90) {
      addr = addr.toLowerCase();
      break;
    }
  }
  if (addr.startsWith("0x") && addr.length < 42) {
    addr = `0x${addr.slice(2).padStart(40, "0")}`;
  }
  return addr;
}
