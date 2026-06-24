#!/usr/bin/env python3
"""
validate_data.py — Validate workspace-local token data files and token_registry.db.

Checks address format, decimals range (0–255), cross-file conflicts, and known
bad patterns (e.g. legacy bulk snapshot with mass decimals=9 defaults).

No network access. All paths are under the repo root.

Usage:
    python3 scripts/validate_data.py
    python3 scripts/validate_data.py --fix-ndjson   # dedupe ndjson in-place (optional)
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from collections import Counter
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = PROJECT_ROOT / "data"
TOKEN_REGISTRY_DB = DATA_DIR / "token_registry.db"

HEX_ADDR = re.compile(r"^0x[a-f0-9]{40}$")

DISCOVERED_NDJSON = DATA_DIR / "discovered-decimals.ndjson"
DISCOVERED_JSON_LEGACY = DATA_DIR / "discovered-decimals.json"
FAILED_NDJSON = DATA_DIR / "failed-decimals.ndjson"
EXTRA_TOKENS = DATA_DIR / "extra-tokens.json"
POOLS_JSON = DATA_DIR / "pools.json"

# Legacy bulk file had ~20k entries with decimals=9 from an old defaulting bug.
LEGACY_SUSPICIOUS_DECIMAL = 9
LEGACY_SUSPICIOUS_THRESHOLD = 1000


def load_failed_ndjson(path: Path) -> tuple[set[str], list[str]]:
    """Each line is a JSON-encoded address string (matches appendFailedTokens format)."""
    addrs: set[str] = set()
    issues: list[str] = []
    if not path.exists():
        return addrs, issues
    for i, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        try:
            parsed = json.loads(line)
            addr = parsed if isinstance(parsed, str) else None
        except json.JSONDecodeError:
            addr = line.strip('"') if line.startswith("0x") else None
        if not addr or not isinstance(addr, str):
            issues.append(f"  ❌ {path.name} line {i}: expected JSON address string")
            continue
        addr = addr.lower()
        if not HEX_ADDR.match(addr):
            issues.append(f"  ❌ {path.name} line {i}: bad address {addr!r}")
            continue
        if addr in addrs:
            issues.append(f"  ⚠️  {path.name} line {i}: duplicate {addr}")
        addrs.add(addr)
    return addrs, issues


def load_ndjson_map(path: Path) -> tuple[dict[str, int], list[str]]:
    entries: dict[str, int] = {}
    issues: list[str] = []
    if not path.exists():
        return entries, issues
    for i, raw in enumerate(path.read_text().splitlines(), 1):
        line = raw.strip()
        if not line:
            continue
        try:
            obj = json.loads(line)
        except json.JSONDecodeError as e:
            issues.append(f"  ❌ {path.name} line {i}: invalid JSON — {e}")
            continue
        addr = str(obj.get("address", "")).lower()
        dec = obj.get("decimals")
        if not HEX_ADDR.match(addr):
            issues.append(f"  ❌ {path.name} line {i}: bad address {addr!r}")
            continue
        if not isinstance(dec, int) or dec < 0 or dec > 255:
            issues.append(f"  ❌ {path.name} line {i}: decimals out of uint8 range — {dec!r}")
            continue
        if addr in entries and entries[addr] != dec:
            issues.append(
                f"  ⚠️  {path.name}: duplicate {addr} with conflicting decimals "
                f"({entries[addr]} vs {dec})"
            )
        entries[addr] = dec
    return entries, issues


def load_json_addr_map(path: Path) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    if not path.exists():
        return {}, issues
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return {}, [f"  ❌ {path.name}: invalid JSON — {e}"]
    if not isinstance(data, dict):
        return {}, [f"  ❌ {path.name}: expected address→decimals object"]
    out: dict[str, int] = {}
    for raw_addr, dec in data.items():
        addr = str(raw_addr).lower()
        if not HEX_ADDR.match(addr):
            issues.append(f"  ❌ {path.name}: bad address {addr!r}")
            continue
        if not isinstance(dec, int) or dec < 0 or dec > 255:
            issues.append(f"  ❌ {path.name}: {addr} decimals out of range — {dec!r}")
            continue
        out[addr] = dec
    return out, issues


def load_extra_tokens(path: Path) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    if not path.exists():
        return {}, issues
    try:
        data = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return {}, [f"  ❌ {path.name}: invalid JSON — {e}"]
    if not isinstance(data, list):
        return {}, [f"  ❌ {path.name}: expected array of {{address, decimals}}"]
    out: dict[str, int] = {}
    for i, item in enumerate(data, 1):
        if not isinstance(item, dict):
            issues.append(f"  ❌ {path.name}[{i}]: expected object")
            continue
        addr = str(item.get("address", "")).lower()
        dec = item.get("decimals")
        if not HEX_ADDR.match(addr):
            issues.append(f"  ❌ {path.name}[{i}]: bad address {addr!r}")
            continue
        if not isinstance(dec, int) or dec < 0 or dec > 255:
            issues.append(f"  ❌ {path.name}[{i}]: bad decimals {dec!r}")
            continue
        out[addr] = dec
    return out, issues


def load_pools(path: Path) -> tuple[set[str], list[str]]:
    issues: list[str] = []
    tokens: set[str] = set()
    if not path.exists():
        return tokens, issues
    try:
        pools = json.loads(path.read_text())
    except json.JSONDecodeError as e:
        return tokens, [f"  ❌ {path.name}: invalid JSON — {e}"]
    if not isinstance(pools, list):
        return tokens, [f"  ❌ {path.name}: expected array of pool objects"]
    for i, pool in enumerate(pools, 1):
        if not isinstance(pool, dict):
            issues.append(f"  ❌ {path.name}[{i}]: expected object")
            continue
        for addr in pool.get("tokens") or []:
            a = str(addr).lower()
            if HEX_ADDR.match(a):
                tokens.add(a)
            else:
                issues.append(f"  ❌ {path.name}[{i}]: bad token address {addr!r}")
    return tokens, issues


def load_db(path: Path) -> tuple[dict[str, int], list[str]]:
    issues: list[str] = []
    if not path.exists():
        issues.append(f"  ⚠️  {path.name}: missing (indexer falls back to RPC for all tokens)")
        return {}, issues
    try:
        conn = sqlite3.connect(path)
        rows = conn.execute("SELECT address, decimals FROM token_decimals").fetchall()
        conn.close()
    except sqlite3.Error as e:
        return {}, [f"  ❌ {path.name}: sqlite error — {e}"]
    out: dict[str, int] = {}
    for addr, dec in rows:
        a = str(addr).lower()
        if not HEX_ADDR.match(a):
            issues.append(f"  ❌ {path.name}: bad address {a!r}")
            continue
        if not isinstance(dec, int) or dec < 0 or dec > 255:
            issues.append(f"  ❌ {path.name}: {a} bad decimals {dec!r}")
            continue
        out[a] = dec
    return out, issues


def check_legacy_json(path: Path) -> list[str]:
    issues: list[str] = []
    if not path.exists():
        return issues
    data, parse_issues = load_json_addr_map(path)
    issues.extend(parse_issues)
    n = len(data)
    nine_count = sum(1 for d in data.values() if d == LEGACY_SUSPICIOUS_DECIMAL)
    issues.append(
        f"  ⚠️  {path.name}: deprecated legacy bulk snapshot ({n} entries, "
        f"{nine_count} with decimals={LEGACY_SUSPICIOUS_DECIMAL}). "
        f"Not used by generate-tokens or runtime — safe to delete after review."
    )
    if nine_count >= LEGACY_SUSPICIOUS_THRESHOLD:
        issues.append(
            f"  ⚠️  {path.name}: {nine_count} entries use decimals={LEGACY_SUSPICIOUS_DECIMAL} "
            f"(likely old defaulting bug). Do not merge into token_registry.db."
        )
    return issues


def cross_check(
    db: dict[str, int],
    ndjson: dict[str, int],
    extra: dict[str, int],
    pool_tokens: set[str],
    failed: set[str],
) -> list[str]:
    issues: list[str] = []

    missing_ndjson_in_db = [a for a in ndjson if a not in db]
    if missing_ndjson_in_db:
        issues.append(
            f"  ℹ️  {len(missing_ndjson_in_db)} ndjson entries not yet in token_registry.db "
            f"— run `bun run generate-tokens`"
        )

    ndjson_db_conflicts = [(a, ndjson[a], db[a]) for a in ndjson if a in db and ndjson[a] != db[a]]
    for addr, nd, dbd in ndjson_db_conflicts[:5]:
        issues.append(
            f"  ⚠️  ndjson vs db conflict: {addr} ndjson={nd} db={dbd} "
            f"(ndjson wins on next generate-tokens run)"
        )
    if len(ndjson_db_conflicts) > 5:
        issues.append(f"  ⚠️  … and {len(ndjson_db_conflicts) - 5} more ndjson/db conflicts")

    for addr, dec in extra.items():
        if addr in db and db[addr] != dec:
            issues.append(
                f"  ℹ️  extra-tokens override pending: {addr} extra={dec} db={db[addr]}"
            )

    missing_pool = [t for t in pool_tokens if t not in db and t not in ndjson]
    if missing_pool:
        issues.append(
            f"  ℹ️  {len(missing_pool)} pools.json token(s) not in db/ndjson "
            f"(generate-tokens adds them with decimals=18 placeholder)"
        )

    return issues


def dedupe_ndjson(path: Path) -> int:
    entries, _ = load_ndjson_map(path)
    if not path.exists():
        return 0
    lines = [json.dumps({"address": a, "decimals": d}) + "\n" for a, d in sorted(entries.items())]
    path.write_text("".join(lines))
    return len(entries)


def validate() -> list[str]:
    issues: list[str] = []

    ndjson, ndjson_issues = load_ndjson_map(DISCOVERED_NDJSON)
    issues.extend(ndjson_issues)
    extra, extra_issues = load_extra_tokens(EXTRA_TOKENS)
    issues.extend(extra_issues)
    pool_tokens, pool_issues = load_pools(POOLS_JSON)
    issues.extend(pool_issues)
    db, db_issues = load_db(TOKEN_REGISTRY_DB)
    issues.extend(db_issues)

    failed, failed_issues = load_failed_ndjson(FAILED_NDJSON)
    issues.extend(failed_issues)

    issues.extend(check_legacy_json(DISCOVERED_JSON_LEGACY))
    issues.extend(cross_check(db, ndjson, extra, pool_tokens, failed))

    # Summary info
    if ndjson:
        dist = Counter(ndjson.values()).most_common(5)
        issues.append(
            f"  ℹ️  discovered-decimals.ndjson: {len(ndjson)} RPC-verified entries; "
            f"top decimals: {dist}"
        )
    if db:
        issues.append(f"  ℹ️  token_registry.db: {len(db)} entries")
    if failed:
        issues.append(f"  ℹ️  failed-decimals.ndjson: {len(failed)} blocklisted addresses")
        if "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" in failed:
            issues.append(
                "  ℹ️  failed-decimals.ndjson includes native-currency sentinel "
                "0xeeee…eeee (expected — not an ERC20 on Polygon)."
            )

    overlap = set(ndjson) & failed
    if overlap:
        issues.append(
            f"  ⚠️  {len(overlap)} address(es) in both discovered and failed lists: "
            f"{sorted(overlap)[:3]}{'…' if len(overlap) > 3 else ''}"
        )

    overlap_db = failed & set(db)
    if overlap_db:
        issues.append(
            f"  ⚠️  {len(overlap_db)} blocklisted address(es) also in token_registry.db "
            f"(runtime blocklist wins): {sorted(overlap_db)[:3]}{'…' if len(overlap_db) > 3 else ''}"
        )

    return issues


def print_report(issues: list[str]) -> int:
    if not issues:
        print("✅ All local data files valid.")
        return 0

    errors = sum(1 for i in issues if "❌" in i)
    warns = sum(1 for i in issues if "⚠️" in i)
    infos = sum(1 for i in issues if "ℹ️" in i)

    print(f"\n{'=' * 60}")
    print("  Local Data Validation Report")
    print(f"{'=' * 60}")
    print(f"  Errors:   {errors}")
    print(f"  Warnings: {warns}")
    print(f"  Info:     {infos}")
    print(f"{'=' * 60}\n")

    for issue in issues:
        s = issue.strip()
        if "❌" in s:
            print(f"[ERROR]    {s}\n")
        elif "⚠️" in s:
            print(f"[WARNING]  {s}\n")
        else:
            print(f"[INFO]     {s}\n")

    return 1 if errors > 0 else 0


def main() -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Validate workspace-local token data files.")
    parser.add_argument(
        "--fix-ndjson",
        action="store_true",
        help="Rewrite discovered-decimals.ndjson deduplicated (last entry wins)",
    )
    args = parser.parse_args()

    if args.fix_ndjson and DISCOVERED_NDJSON.exists():
        n = dedupe_ndjson(DISCOVERED_NDJSON)
        print(f"Deduplicated {DISCOVERED_NDJSON.name} → {n} entries")

    return print_report(validate())


if __name__ == "__main__":
    sys.exit(main())
