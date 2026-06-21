import { appendFile, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Append a newly indexed pool to the bot-facing NDJSON delta tail. */
export async function appendPoolDiscoveryDelta(
  pool: { id: string; address: string; protocol: string; tokens: string[]; createdBlock: number },
  deltaPath = path.join("data", "discovery-delta.ndjson"),
): Promise<void> {
  await mkdir(path.dirname(deltaPath), { recursive: true });
  await appendFile(deltaPath, JSON.stringify(pool) + "\n", "utf8");
}

/** Load auto-extra token entries from JSON array and optional NDJSON append log. */
export async function loadAutoExtraEntries(jsonPath: string, ndjsonPath: string): Promise<Array<{ address: string; decimals: number }>> {
  const byAddr = new Map<string, number>();

  try {
    const raw = await readFile(jsonPath, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const entry of data) {
        if (!entry?.address || typeof entry.decimals !== "number") continue;
        byAddr.set(String(entry.address).toLowerCase(), entry.decimals);
      }
    }
  } catch {
    // File may not exist yet
  }

  try {
    const raw = await readFile(ndjsonPath, "utf8");
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const entry = JSON.parse(trimmed) as { address?: string; decimals?: number };
        if (entry?.address && typeof entry.decimals === "number") {
          byAddr.set(String(entry.address).toLowerCase(), entry.decimals);
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch {
    // Append log may not exist yet
  }

  return Array.from(byAddr.entries()).map(([address, decimals]) => ({ address, decimals }));
}

/** Append one auto-extra token entry without read-modify-write on the JSON file. */
export async function appendAutoExtraEntry(ndjsonPath: string, address: string, decimals: number): Promise<void> {
  await mkdir(path.dirname(ndjsonPath), { recursive: true });
  await appendFile(ndjsonPath, JSON.stringify({ address, decimals }) + "\n", "utf8");
}

/** Load garbage addresses from JSON array and optional NDJSON append log. */
export async function loadGarbageAddressEntries(jsonPath: string, ndjsonPath: string): Promise<string[]> {
  const addrs = new Set<string>();

  try {
    const raw = await readFile(jsonPath, "utf8");
    const data = JSON.parse(raw);
    if (Array.isArray(data)) {
      for (const addr of data) {
        if (typeof addr === "string" && addr.startsWith("0x")) {
          addrs.add(addr.toLowerCase());
        }
      }
    }
  } catch {
    // File may not exist yet
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

/** Append newly marked garbage addresses without rewriting the full JSON file. */
export async function appendGarbageAddresses(ndjsonPath: string, addresses: readonly string[]): Promise<void> {
  if (addresses.length === 0) return;
  await mkdir(path.dirname(ndjsonPath), { recursive: true });
  const payload = addresses.map((addr) => JSON.stringify(addr.toLowerCase()) + "\n").join("");
  await appendFile(ndjsonPath, payload, "utf8");
}

/** Load discovered decimals from JSON object map and optional NDJSON append log. */
export async function loadDiscoveredDecimalsEntries(
  jsonPath: string,
  ndjsonPath: string,
): Promise<Record<string, number>> {
  const byAddr: Record<string, number> = {};

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
    // File may not exist yet
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

/** Append newly discovered decimals without read-modify-write on the JSON file. */
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

/** Load permanently failed token addresses from JSON and optional NDJSON append log. */
export async function loadFailedTokenEntries(jsonPath: string, ndjsonPath: string): Promise<string[]> {
  const addrs = new Set<string>();

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

/** Append permanently failed token addresses without rewriting the full JSON file. */
export async function appendFailedTokens(ndjsonPath: string, addresses: readonly string[]): Promise<void> {
  if (addresses.length === 0) return;
  await mkdir(path.dirname(ndjsonPath), { recursive: true });
  const payload = addresses.map((addr) => JSON.stringify(addr.toLowerCase()) + "\n").join("");
  await appendFile(ndjsonPath, payload, "utf8");
}

/** Write compact JSON atomically via temp file + rename. */
export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(tmpPath, JSON.stringify(data), "utf8");
  await rename(tmpPath, filePath);
}
