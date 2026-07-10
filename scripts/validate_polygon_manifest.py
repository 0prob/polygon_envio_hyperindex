#!/usr/bin/env python3
"""Fail-closed validation of the checked-in Polygon deployment manifest."""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "data/polygon-protocol-manifest.json"
CONSTANTS = ROOT / "src/utils/constants.ts"
TOKEN_GENERATOR = ROOT / "scripts/generate-polygon-tokens.ts"
POOLS = ROOT / "data/pools.json"

def main(path=MANIFEST):
    doc = json.loads(Path(path).read_text())
    assert doc["chain"]["chain_id"] == 137
    seen = set()
    for d in doc["deployments"]:
        a = d["address"].lower()
        if not re.fullmatch(r"0x[0-9a-f]{40}", a): raise ValueError(f"invalid address: {a}")
        if a in seen: raise ValueError(f"duplicate address: {a}")
        seen.add(a)
        if d.get("outcome") not in ("verified executable", "quarantined"):
            raise ValueError(f"unsupported outcome: {d.get('outcome')}")
    usdc_e = next(d["address"].lower() for d in doc["deployments"] if d["name"] == "usdc.e")
    constants_text = CONSTANTS.read_text().lower()
    generator_text = TOKEN_GENERATOR.read_text().lower()
    pools = json.loads(POOLS.read_text())
    if usdc_e not in constants_text:
        raise ValueError("usdc.e address drift in constants.ts")
    if usdc_e not in generator_text:
        raise ValueError("usdc.e address drift in generate-polygon-tokens.ts")
    if not any(usdc_e in pool.get("tokens", []) for pool in pools):
        raise ValueError("usdc.e address missing from pools.json")
    print(f"MANIFEST_VALID: {len(seen)} deployments")

if __name__ == "__main__":
    try: main(sys.argv[1] if len(sys.argv) > 1 else MANIFEST)
    except (AssertionError, KeyError, ValueError, json.JSONDecodeError) as e:
        print(f"MANIFEST_INVALID: {e}", file=sys.stderr); sys.exit(1)
