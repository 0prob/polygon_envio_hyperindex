/** Lowercase 20-byte address; left-pads short 0x-prefixed hex for registry/Hasura keys. */
export function normalizeTokenAddress(address: string): string {
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
