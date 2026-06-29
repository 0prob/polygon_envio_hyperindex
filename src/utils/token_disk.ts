import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Load discovered decimals from NDJSON append log. */
export async function loadDiscoveredDecimalsEntries(ndjsonPath: string): Promise<Record<string, number>> {
  const byAddr: Record<string, number> = {};

  try {
    const raw = await readFile(ndjsonPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { address?: string; decimals?: number };
        if (entry?.address && typeof entry.decimals === "number") {
          byAddr[String(entry.address).toLowerCase()] = entry.decimals;
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Append log may not exist yet
  }

  return byAddr;
}

/** Append newly discovered decimals without read-modify-write on any JSON snapshot. */
export async function appendDiscoveredDecimals(
  ndjsonPath: string,
  entries: ReadonlyArray<{ address: string; decimals: number }>,
): Promise<void> {
  if (entries.length === 0) return;
  await mkdir(path.dirname(ndjsonPath), { recursive: true });
  const payload = entries
    .map(({ address, decimals }) => JSON.stringify({ address, decimals }) + "\n")
    .join("");
  await appendFile(ndjsonPath, payload, "utf8");
}

/** Load permanently failed token addresses from NDJSON append log. */
export async function loadFailedTokenEntries(ndjsonPath: string): Promise<string[]> {
  const addrs = new Set<string>();

  try {
    const raw = await readFile(ndjsonPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const addr = JSON.parse(trimmed);
        if (typeof addr === "string" && addr.startsWith("0x")) {
          addrs.add(addr.toLowerCase());
        }
      } catch {
        if (trimmed.startsWith("0x")) addrs.add(trimmed.toLowerCase());
      }
    }
  } catch {
    // Append log may not exist yet
  }

  return [...addrs];
}

/** Append permanently failed token addresses without rewriting any JSON snapshot. */
export async function appendFailedTokens(ndjsonPath: string, addresses: readonly string[]): Promise<void> {
  if (addresses.length === 0) return;
  await mkdir(path.dirname(ndjsonPath), { recursive: true });
  const payload = addresses.map((addr) => JSON.stringify(addr.toLowerCase()) + "\n").join("");
  await appendFile(ndjsonPath, payload, "utf8");
}
