#!/usr/bin/env python3
"""
validate_envio_config.py — AST-style static analysis for Envio config.yaml vs ABIs.

Checks:
  1. All config-registered events exist in the ABI file.
  2. Anonymous event detection (requires special handler awareness).
  3. EVM type → GraphQL Int overflow risk (uint40+, int128+, etc.).
  4. ABI events that are NOT in config but carry discovery-critical data.
  5. Unnamed event params that handlers may miss.
  6. Config YAML structure sanity (contract name, abi_file_path presence).

Usage:
    python3 scripts/validate_envio_config.py                    # uses config.yaml
    python3 scripts/validate_envio_config.py --config path.yaml  # explicit path
"""

import json
import os
import re
import sys
from pathlib import Path

# ── package-wide root (same layout in CI and dev) ───────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "config.yaml"

# ── Envio type-safety rules ─────────────────────────────────────
# Types that MUST be stored as BigInt, never as Int.
WIDE_EVM_TYPES = {"uint256", "int256", "uint128", "int128", "uint160", "int160"}

# Types safe for GraphQL Int (signed 32-bit) when cast via Number().
# Max uint24 = 16,777,215  < 2^31. uint32 OK if range known < 2^31.
NARROW_EVM_TYPES = {"uint8", "uint16", "uint24", "int16", "int24", "bool"}

# Types that map to String (address, bytes).
STRING_EVM_TYPES = {"address", "bytes", "bytes32", "string"}

# Events that the project intentionally excluded (per handler comments).
EXCLUDED_EVENTS = {
    ("PoolManager", "Swap"),
    ("BalancerVault", "PoolBalanceChanged"),
    ("BalancerVault", "Swap"),
}

# ABI params that exist on-chain but are intentionally unused by handlers.
# (contract_name, event_name, param_name) or ("*", event_name, param_name) for all.
SUPPRESSED_TYPE_WARNINGS: set[tuple[str, str, str]] = {
    ("V2Factory", "PairCreated", "_3"),           # unnamed uint256 (pool length)
    ("CurveRegistry", "PoolAdded", "n_coins"),     # uint256, used only as effect input (never stored in Int)
    ("CurveRegistry", "PoolAdded", "nCoins"),
    ("PoolManager", "Initialize", "sqrtPriceX96"),  # uint160, unused by handler
    ("PoolManager", "Initialize", "tick"),          # int24, unused by handler
    ("WooPPV2", "WooSwap", "fromAmount"),
    ("WooPPV2", "WooSwap", "toAmount"),
    ("WooPPV2", "WooSwap", "swapVol"),
    ("WooPPV2", "WooSwap", "swapFee"),
    ("WooPPV2", "WooSwap", "from"),
    ("WooPPV2", "WooSwap", "to"),
    ("WooPPV2", "WooSwap", "rebateTo"),
}


def load_yaml(path: Path):
    """Load config.yaml — try ruamel.yaml first, fall back to PyYAML."""
    try:
        import ruamel.yaml as ryaml
        y = ryaml.YAML(typ="safe")
        with open(path) as f:
            return y.load(f)
    except ImportError:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f)


def load_abi(path: Path) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def abi_events(abi: list[dict]) -> list[dict]:
    return [item for item in abi if item.get("type") == "event"]


def resolve_abi_path(abi_file_path: str) -> Path:
    """Resolve relative paths from project root."""
    p = Path(abi_file_path)
    if p.is_absolute():
        return p
    return (PROJECT_ROOT / abi_file_path).resolve()


def event_signature(event_def: dict, compact=True) -> str:
    """Build human-readable signature from ABI event definition."""
    name = event_def["name"]
    sep = "," if compact else ", "
    params = sep.join(
        inp.get("type", "?")
        for inp in event_def.get("inputs", [])
    )
    return f"{name}({params})"


def _normalize_sig(s: str) -> str:
    """Remove whitespace from a signature for comparison."""
    return re.sub(r"\s+", "", s)

def check_event_exists(contract_name, event_cfg, abi_evts):
    """Check a config event entry matches at least one ABI event definition."""
    name = event_cfg.get("event", "")
    sig_name = name.split("(")[0] if "(" in name else name

    matching = [e for e in abi_evts if e["name"] == sig_name]
    if not matching:
        return [f"  ❌ Contract '{contract_name}': event '{sig_name}' not found in ABI"]

    issues = []
    if "(" in name:
        norm_config = _normalize_sig(name)
        any_match = False
        for e in matching:
            abi_sig = event_signature(e)
            if _normalize_sig(abi_sig) == norm_config:
                any_match = True
                break
        if not any_match:
            sigs = ", ".join(event_signature(e, compact=False) for e in matching)
            issues.append(
                f"  ⚠️  Contract '{contract_name}': event signature '{name}' vs ABI.\n"
                f"      ABI offers: {sigs}"
            )
    return issues


def check_anonymous_events(contract_name, abi_evts):
    """Flag anonymous events that require special handler awareness."""
    issues = []
    for evt in abi_evts:
        if evt.get("anonymous", False):
            issues.append(
                f"  🚨 Contract '{contract_name}': event '{evt['name']}' is ANONYMOUS.\n"
                f"      Envio indexes by event signature hash — anonymous events lack one.\n"
                f"      Verify your config.yaml event signature is exact."
            )
    return issues


def check_missing_discovery_events(contract_name, event_names_in_config, abi_evts):
    """Flag ABI events not in config that are not in the exclusion list."""
    issues = []
    for evt in abi_evts:
        name = evt["name"]
        if name in event_names_in_config:
            continue
        if (contract_name, name) in EXCLUDED_EVENTS:
            continue
        issues.append(
            f"  📋 Contract '{contract_name}': event '{name}' is in ABI but NOT configured.\n"
            f"      Inputs: {[i.get('name', f'_{i}') + ':' + i['type'] for i in evt.get('inputs', [])]}"
        )
    return issues


def _suppressed(cname: str, ename: str, pname: str) -> bool:
    for s_cname, s_ename, s_pname in SUPPRESSED_TYPE_WARNINGS:
        if s_cname == "*" or s_cname == cname:
            if s_ename == ename and s_pname == pname:
                return True
    return False

def check_type_safety(contract_name, event_cfg, abi_evts):
    """Check EVM types stored in GraphQL Int fields for overflow risk."""
    issues = []
    name = event_cfg.get("event", "").split("(")[0]

    for evt in abi_evts:
        if evt["name"] != name:
            continue
        for inp in evt.get("inputs", []):
            evm_type = inp.get("type", "").rstrip("[]")
            pname = inp.get("name") or "_3"
            if evm_type in WIDE_EVM_TYPES:
                if not _suppressed(contract_name, name, pname):
                    issues.append(
                        f"  ⚠️  Contract '{contract_name}.{name}': param '{pname}' is "
                        f"'{evm_type}' → ensure handler stores in BigInt, NOT in schema Int."
                    )
            elif evm_type not in NARROW_EVM_TYPES and evm_type not in STRING_EVM_TYPES and evm_type:
                if not _suppressed(contract_name, name, pname):
                    issues.append(
                        f"  ℹ️  Contract '{contract_name}.{name}': param '{pname}' is "
                        f"'{evm_type}' — verify type mapping."
                    )
    return issues


def check_unnamed_params(contract_name, event_cfg, abi_evts):
    """Warn about unnamed event params (accessible via _0, _1, ... in Envio)."""
    issues = []
    name = event_cfg.get("event", "").split("(")[0]
    for evt in abi_evts:
        if evt["name"] != name:
            continue
        unnamed = [inp for inp in evt.get("inputs", []) if not inp.get("name")]
        if unnamed:
            sig = event_signature(evt)
            details = "; ".join(f"index {i}: {inp['type']}" for i, inp in enumerate(unnamed))
            issues.append(
                f"  ℹ️  Contract '{contract_name}': event '{sig}' has unnamed params.\n"
                f"      Envio auto-names as `_0`, `_1`, etc. — verify handler accesses: {details}"
            )
    return issues


def validate_single_run(config_path: Path) -> list[str]:
    """Run the full validation suite, returning a list of issue strings."""
    if not config_path.exists():
        return [f"❌ Config file not found: {config_path}"]

    config = load_yaml(config_path)
    all_issues: list[str] = []
    seen_contracts: set[str] = set()

    # ── Global checks ────────────────────────────────────────
    if config.get("raw_events", False):
        all_issues.append("  ℹ️  raw_events: true — event payloads stored in DB (debug only).")
    if config.get("rollback_on_reorg", True) is False:
        all_issues.append("  🚨 rollback_on_reorg: false — entity state may diverge on chain reorg.")

    # ── Build contract-def map ───────────────────────────────
    contract_defs: dict[str, dict] = {}
    for cdef in config.get("contracts", []):
        name = cdef["name"]
        contract_defs[name] = cdef

    # ── Validate each unique contract once ───────────────────
    for cname, defn in contract_defs.items():
        if cname in seen_contracts:
            continue
        seen_contracts.add(cname)

        # ── Resolve ABI ──────────────────────────────────────
        abi_rel = defn.get("abi_file_path") or defn.get("abi")
        if not abi_rel:
            all_issues.append(f"  ❌ Contract '{cname}': no abi_file_path or abi in definition.")
            continue

        abi_path = resolve_abi_path(abi_rel)
        if not abi_path.exists():
            all_issues.append(f"  ❌ Contract '{cname}': ABI not found at {abi_path}")
            continue

        abi = load_abi(abi_path)
        abi_evts = abi_events(abi)

        # ── Config events list ───────────────────────────────
        cfg_events = defn.get("events", [])
        cfg_event_names = {
            (e.get("event", "")).split("(")[0]
            for e in cfg_events
        }

        for evt_cfg in cfg_events:
            all_issues.extend(check_event_exists(cname, evt_cfg, abi_evts))
            all_issues.extend(check_type_safety(cname, evt_cfg, abi_evts))
            all_issues.extend(check_unnamed_params(cname, evt_cfg, abi_evts))

        all_issues.extend(check_anonymous_events(cname, abi_evts))
        all_issues.extend(check_missing_discovery_events(cname, cfg_event_names, abi_evts))

    # ── Structural: per-chain addresses ──────────────────────
    for chain in config.get("chains", []):
        chain_id = chain.get("id", "?")
        per_chain = chain.get("contracts", [])
        for pc in per_chain:
            cname = pc["name"]
            if "address" not in pc:
                all_issues.append(f"  ❌ Chain {chain_id} contract '{cname}': no address configured.")
            if cname not in contract_defs:
                all_issues.append(f"  ❌ Chain {chain_id}: contract '{cname}' has no top-level definition.")

    return all_issues


def print_report(issues: list[str]) -> int:
    """Print formatted report; return exit code."""
    if not issues:
        print("✅ All checks passed — no structural issues found.")
        return 0

    error_count = sum(1 for i in issues if "❌" in i or "🚨" in i)
    warn_count = sum(1 for i in issues if "⚠️" in i or "📋" in i)
    info_count = sum(1 for i in issues if "ℹ️" in i)

    print(f"\n{'=' * 60}")
    print(f"  Envio Config Validation Report")
    print(f"{'=' * 60}")
    print(f"  Errors:  {error_count}")
    print(f"  Warnings: {warn_count}")
    print(f"  Info:     {info_count}")
    print(f"{'=' * 60}\n")

    for issue in issues:
        prefix = issue.strip()[0]
        if prefix in ("❌", "🚨"):
            print(f"[ERROR]    {issue.strip()}")
        elif prefix in ("⚠️", "📋"):
            print(f"[WARNING]  {issue.strip()}")
        else:
            print(f"[INFO]     {issue.strip()}")
        print()

    return 1 if error_count > 0 else 0


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="AST-style static analysis for Envio config.yaml vs ABIs."
    )
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG),
        help=f"Path to config.yaml (default: {DEFAULT_CONFIG})",
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    issues = validate_single_run(config_path)
    return print_report(issues)


if __name__ == "__main__":
    sys.exit(main())
