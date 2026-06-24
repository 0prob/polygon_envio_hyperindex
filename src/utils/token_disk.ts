import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";

/** Load discovered decimals from an optional JSON snapshot and/or NDJSON append log. */
export async function loadDiscoveredDecimalsEntries(
  jsonPath: string | null,
  ndjsonPath: string,
): Promise<Record<string, number>> {
  const byAddr: Record<string, number> = {};

  if (jsonPath) {
    try {
      const raw = await readFile(jsonPath, "utf8");
      const data = JSON.parse(raw);
      if (data && typeof data === "object" && !Array.isArray(data)) {
        for (const [addr, dec] of Object.entries(data)) {
          if (typeof addr === "string" && typeof dec === "number") {
            byAddr[addr.toLowerCase()] = dec;
          }
        }
      }
    } catch {
      // Snapshot may not exist
    }
  }

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
    .map(({ address, decimals }) => JSON.stringify({ address: address.toLowerCase(), decimals }) + "\n")
    .join("");
  await appendFile(ndjsonPath, payload, "utf8");
}

/** Load permanently failed token addresses from optional JSON and NDJSON append log. */
export async function loadFailedTokenEntries(jsonPath: string | null, ndjsonPath: string): Promise<string[]> {
  const addrs = new Set<string>();

  if (jsonPath) {
    try {
      const raw = await readFile(jsonPath, "utf8");
      const data = JSON.parse(raw);
      if (Array.isArray(data)) {
        for (const addr of data) {
          if (typeof addr === "string" && addr.startsWith("0x")) {
            addrs.add(addr.toLowerCase());
          }
        }
      } else if (data && typeof data === "object") {
        for (const addr of Object.keys(data)) {
          if (addr.startsWith("0x")) addrs.add(addr.toLowerCase());
        }
      }
    } catch {
      // File may not exist yet
    }
  }

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
