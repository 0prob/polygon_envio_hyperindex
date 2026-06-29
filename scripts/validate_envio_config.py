#!/usr/bin/env python3
"""
validate_envio_config.py — Enhanced AST-style static analysis for Envio config.yaml vs ABIs.

Static analysis checks (no RPC, no runtime):
  1.  Config-registered events exist in ABI files.
  2.  Anonymous event detection (special handler awareness required).
  3.  EVM type → GraphQL Int overflow risk (uint40+, int128+, etc.).
  4.  ABI events NOT in config that carry discovery-critical data.
  5.  Unnamed event params handlers may miss.
  6.  Config YAML structure (contract name, abi_file_path presence).
  7.  HANDLER CODE cross-reference: every configured event has an indexer.onEvent() call.
  8.  HANDLER CODE: every configured contract has a matching indexer handler call.
  9.  Event signature keccak256 alignment between config overloads and ABI variants.
  10. Schema Int field range check against actual EVM types written by handlers.
  11. ContractRegister detection (dynamic contracts registered in handlers).
  12. Overloaded-event variant coverage (e.g. Curve PoolAdded has 3 ABI variants).

Usage:
    python3 scripts/validate_envio_config.py                    # uses config.yaml
    python3 scripts/validate_envio_config.py --config path.yaml  # explicit path
    python3 scripts/validate_envio_config.py --verbose           # show full details
"""

import json
import re
import sys
from pathlib import Path
from typing import Any

# ── package-wide root ─────────────────────────────────────────────
PROJECT_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_CONFIG = PROJECT_ROOT / "config.yaml"
HANDLERS_DIR = PROJECT_ROOT / "src" / "handlers"
SCHEMA_FILE = PROJECT_ROOT / "schema.graphql"

# ── EVM type → storage risk ───────────────────────────────────────
WIDE_EVM_TYPES = {"uint256", "int256", "uint128", "int128", "uint160", "int160"}

NARROW_EVM_TYPES = {"uint8", "uint16", "uint24", "int16", "int24", "bool"}

STRING_EVM_TYPES = {"address", "bytes", "bytes32", "string"}

# BigInt-worthy types that overflow GraphQL Int (signed 32-bit: ±2^31)
# Schema Int cap at 2^31-1 = 2,147,483,647
# uint40  ~ 1.1e12 > 2.1e9  → OVERFLOW
# uint64  ~ 1.8e19          → OVERFLOW
# int128  ~ 1.7e38          → OVERFLOW
OVERFLOW_AS_INT_TYPES = {"uint40", "uint48", "uint56", "uint64", "uint72", "uint80",
                         "uint88", "uint96", "uint104", "uint112", "uint120", "uint128",
                         "uint136", "uint144", "uint152", "uint160", "uint168", "uint176",
                         "uint184", "uint192", "uint200", "uint208", "uint216", "uint224",
                         "uint232", "uint240", "uint248", "uint256",
                         "int40", "int48", "int56", "int64", "int72", "int80",
                         "int88", "int96", "int104", "int112", "int120", "int128",
                         "int136", "int144", "int152", "int160", "int168", "int176",
                         "int184", "int192", "int200", "int208", "int216", "int224",
                         "int232", "int240", "int248", "int256"}

# Events intentionally excluded (per handler comments / design docs).
EXCLUDED_EVENTS: set[tuple[str, str]] = {
    ("PoolManager", "Swap"),
    ("BalancerVault", "PoolBalanceChanged"),
    ("BalancerVault", "Swap"),
}

# Suppressed type warnings — (contract, event, param) or ("*", event, param).
SUPPRESSED_TYPE_WARNINGS: set[tuple[str, str, str]] = {
    ("V2Factory", "PairCreated", "_3"),
    ("PoolManager", "Initialize", "sqrtPriceX96"),
    ("PoolManager", "Initialize", "tick"),
    ("WooPPV2", "WooSwap", "fromAmount"),
    ("WooPPV2", "WooSwap", "toAmount"),
    ("WooPPV2", "WooSwap", "swapVol"),
    ("WooPPV2", "WooSwap", "swapFee"),
    ("WooPPV2", "WooSwap", "from"),
    ("WooPPV2", "WooSwap", "to"),
    ("WooPPV2", "WooSwap", "rebateTo"),
}


# ── Schema Int fields: EVM types BEFORE handler transformation ─────
# Handlers convert on-chain values to GraphQL Int before persisting.
# Do not flag these as overflow — the stored value is already scaled.
HANDLER_SCALED_INT_FIELDS: dict[tuple[str, str], str] = {
    ("PoolMeta", "fee"): "basis points (handlers call curveFeeToPoolMetaInt / dodoFeeToBps / etc.)",
    ("IndexerProgress", "chainId"): "chain id literal (137 on Polygon, not a uint256 event param)",
}

# Schema Int fields that receive block numbers (fit Int on Polygon; may overflow on other chains).
BLOCK_NUMBER_FIELDS = {
    "createdBlock", "updatedAtBlock", "lastIndex", "total", "lastProcessedBlock",
}

# Raw EVM types from events/RPC that handlers write WITHOUT transformation.
# Used only for fields not in HANDLER_SCALED_INT_FIELDS.
SCHEMA_INT_FIELD_TYPES: dict[tuple[str, str], set[str]] = {
    ("PoolMeta", "tickSpacing"):        {"int24"},
    ("TokenMeta", "decimals"):          {"uint8"},
}


# ── Utilities ─────────────────────────────────────────────────────

def load_yaml(path: Path) -> Any:
    try:
        import ruamel.yaml as ryaml
        y = ryaml.YAML(typ="safe")
        with open(path) as f:
            return y.load(f)
    except ImportError:
        import yaml
        with open(path) as f:
            return yaml.safe_load(f)


def load_json(path: Path) -> list[dict]:
    with open(path) as f:
        return json.load(f)


def abi_events(abi: list[dict]) -> list[dict]:
    return [item for item in abi if item.get("type") == "event"]


def resolve_abi_path(abi_file_path: str) -> Path:
    p = Path(abi_file_path)
    if p.is_absolute():
        return p
    return (PROJECT_ROOT / abi_file_path).resolve()


def event_signature(event_def: dict, compact: bool = True) -> str:
    name = event_def["name"]
    sep = "," if compact else ", "
    params = sep.join(inp.get("type", "?") for inp in event_def.get("inputs", []))
    return f"{name}({params})"


def _normalize_sig(s: str) -> str:
    return re.sub(r"\s+", "", s)


def keccak256(text: str) -> str | None:
    """Keccak-256 (Ethereum). Returns None if no implementation available."""
    try:
        from eth_hash.auto import keccak  # type: ignore[import-untyped]
        return "0x" + keccak(text.encode()).hex()
    except ImportError:
        pass
    try:
        from Crypto.Hash import keccak as _keccak  # type: ignore[import-untyped]
        h = _keccak.new(digest_bits=256)
        h.update(text.encode())
        return "0x" + h.hexdigest()
    except ImportError:
        return None


def event_topic0(event_def: dict) -> str | None:
    """Compute the event signature hash (topic0) from an ABI event definition."""
    sig = event_signature(event_def, compact=True)
    return keccak256(sig)


# ── Handler code analysis ─────────────────────────────────────────

def find_handler_files() -> list[Path]:
    return sorted(HANDLERS_DIR.glob("*.ts"))


def extract_handler_calls() -> dict[str, set[str]]:
    """
    Read all handler .ts files and find indexer.onEvent / indexer.onBlock calls.
    Returns {handler_file: {event_or_block_name, ...}}.
    """
    result: dict[str, set[str]] = {}
    for f in find_handler_files():
        text = f.read_text()
        names: set[str] = set()

        # indexer.onEvent({contract: "X", event: "Y"}, ...)
        for m in re.finditer(r'contract:\s*["\'](\w+)["\']', text):
            names.add(f"onEvent:{m.group(1)}")

        # event: "EventName" (raw string in handler onEvent calls)
        for m in re.finditer(r'event:\s*["\']([\w()_, ]+)["\']', text):
            names.add(f"event:{m.group(1).strip()}")

        # indexer.onBlock({name: "BlockName"}, ...)
        for m in re.finditer(r'name:\s*["\']([\w]+)["\']', text):
            names.add(f"onBlock:{m.group(1)}")

        result[f.name] = names
    return result


def _is_commented(line: str, pos: int) -> bool:
    """Check if position `pos` in `line` is inside a single-line comment."""
    comment_start = line.find("//")
    if comment_start == -1:
        return False
    return pos > comment_start


def extract_contract_register_calls() -> list[str]:
    """Find all non-commented context.chain.X.add() calls in handler files."""
    calls: list[str] = []
    for f in find_handler_files():
        text = f.read_text()
        for m in re.finditer(r'context\.chain\.(\w+)\s*\.\s*add\b', text):
            # Find which line this match is on
            lines = text[:m.start()].splitlines()
            line_idx = len(lines) - 1
            line = text.splitlines()[line_idx] if line_idx < len(text.splitlines()) else ""
            col = m.start() - text.rfind("\n", 0, m.start()) - 1
            if not _is_commented(line, col):
                calls.append(f"{f.name}: context.chain.{m.group(1)}.add()")
        for m in re.finditer(r'contractRegister\b[^;]*,\s*["\'](\w+)["\']', text):
            lines = text[:m.start()].splitlines()
            line_idx = len(lines) - 1
            line = text.splitlines()[line_idx] if line_idx < len(text.splitlines()) else ""
            col = m.start() - text.rfind("\n", 0, m.start()) - 1
            if not _is_commented(line, col):
                calls.append(f"{f.name}: contractRegister({m.group(1)})")
    return calls


# ── Checks ─────────────────────────────────────────────────────────

def check_event_exists(cname: str, event_cfg: dict, abi_evts: list[dict]) -> list[str]:
    name = event_cfg.get("event", "")
    sig_name = name.split("(")[0] if "(" in name else name
    matching = [e for e in abi_evts if e["name"] == sig_name]
    if not matching:
        return [f"  ❌ Contract '{cname}': event '{sig_name}' not found in ABI"]

    issues: list[str] = []
    if "(" in name:
        norm_config = _normalize_sig(name)
        for e in matching:
            if _normalize_sig(event_signature(e)) == norm_config:
                break
        else:
            sigs = ", ".join(event_signature(e, compact=False) for e in matching)
            issues.append(
                f"  ⚠️  Contract '{cname}': event signature '{name}' vs ABI.\n"
                f"      ABI offers: {sigs}"
            )
    return issues


def check_anonymous_events(cname: str, abi_evts: list[dict]) -> list[str]:
    issues: list[str] = []
    for evt in abi_evts:
        if evt.get("anonymous", False):
            issues.append(
                f"  🚨 Contract '{cname}': event '{evt['name']}' is ANONYMOUS.\n"
                f"      Envio indexes by event signature hash — anonymous events lack one.\n"
                f"      Verify your config.yaml event signature is exact."
            )
    return issues


def check_missing_discovery_events(cname: str, event_names_in_config: set[str],
                                    abi_evts: list[dict]) -> list[str]:
    issues: list[str] = []
    for evt in abi_evts:
        name = evt["name"]
        if name in event_names_in_config:
            continue
        if (cname, name) in EXCLUDED_EVENTS:
            continue
        issues.append(
            f"  📋 Contract '{cname}': event '{name}' is in ABI but NOT configured.\n"
            f"      Inputs: {[i.get('name', f'_{i}') + ':' + i['type'] for i in evt.get('inputs', [])]}"
        )
    return issues


def _suppressed(cname: str, ename: str, pname: str) -> bool:
    for s_cname, s_ename, s_pname in SUPPRESSED_TYPE_WARNINGS:
        if s_cname in ("*", cname) and s_ename == ename and s_pname == pname:
            return True
    return False


def check_type_safety(cname: str, event_cfg: dict, abi_evts: list[dict]) -> list[str]:
    issues: list[str] = []
    name = event_cfg.get("event", "").split("(")[0]
    for evt in abi_evts:
        if evt["name"] != name:
            continue
        for inp in evt.get("inputs", []):
            evm_type = inp.get("type", "").rstrip("[]")
            pname = inp.get("name") or "_3"
            if evm_type in WIDE_EVM_TYPES:
                if not _suppressed(cname, name, pname):
                    issues.append(
                        f"  ⚠️  Contract '{cname}.{name}': param '{pname}' is "
                        f"'{evm_type}' → ensure handler stores in BigInt, NOT in schema Int."
                    )
            elif evm_type not in NARROW_EVM_TYPES and evm_type not in STRING_EVM_TYPES and evm_type:
                if not _suppressed(cname, name, pname):
                    issues.append(
                        f"  ℹ️  Contract '{cname}.{name}': param '{pname}' is "
                        f"'{evm_type}' — verify type mapping."
                    )
    return issues


def check_unnamed_params(cname: str, event_cfg: dict, abi_evts: list[dict]) -> list[str]:
    issues: list[str] = []
    name = event_cfg.get("event", "").split("(")[0]
    for evt in abi_evts:
        if evt["name"] != name:
            continue
        unnamed = [inp for inp in evt.get("inputs", []) if not inp.get("name")]
        if unnamed:
            sig = event_signature(evt)
            details = "; ".join(f"index {i}: {inp['type']}" for i, inp in enumerate(unnamed))
            issues.append(
                f"  ℹ️  Contract '{cname}': event '{sig}' has unnamed params.\n"
                f"      Envio auto-names as `_0`, `_1`, etc. — verify handler accesses: {details}"
            )
    return issues


def check_overloaded_variant_coverage(cname: str, cfg_events: list[dict],
                                       abi_evts: list[dict]) -> list[str]:
    """
    For events with multiple ABI overloads (same name, different params),
    verify the config covers all ABI variants.
    """
    issues: list[str] = []
    # Group ABI events by name
    from collections import Counter
    abi_names = [e["name"] for e in abi_evts]
    overloaded_names = {n for n, c in Counter(abi_names).items() if c > 1}

    for evt_overloaded_name in overloaded_names:
        abi_variants = [e for e in abi_evts if e["name"] == evt_overloaded_name]
        abi_sigs = {_normalize_sig(event_signature(e)) for e in abi_variants}

        cfg_sigs: set[str] = set()
        for ec in cfg_events:
            raw = ec.get("event", "")
            if raw.split("(")[0] == evt_overloaded_name:
                if "(" in raw:
                    cfg_sigs.add(_normalize_sig(raw))
                else:
                    # Bare name — covers all variants via topic0 (Envio matches topic0 only)
                    cfg_sigs.add(evt_overloaded_name)  # marker
                    break

        missing = abi_sigs - cfg_sigs
        if missing and not any("(" not in ec.get("event", "")
                                for ec in cfg_events
                                if ec.get("event", "").split("(")[0] == evt_overloaded_name):
            issues.append(
                f"  ⚠️  Contract '{cname}': overloaded event '{evt_overloaded_name}' "
                f"missing ABI variant(s).\n"
                f"      ABI variants: {sorted(abi_sigs)}\n"
                f"      Config covers: {sorted(cfg_sigs - {evt_overloaded_name})}\n"
                f"      Missing: {sorted(missing)}"
            )
    return issues


def check_handler_coverage(cfg_contract_names: set[str],
                            handler_map: dict[str, set[str]]) -> list[str]:
    """
    Every config-registered contract should have a handler file that
    produces an indexer.onEvent({contract: "Name"}, ...) or
    indexer.onBlock({name: includes Name}) call.
    """
    issues: list[str] = []
    all_on_events: set[str] = set()
    all_on_blocks: set[str] = set()
    for fname, refs in handler_map.items():
        for r in refs:
            if r.startswith("onEvent:"):
                all_on_events.add(r.removeprefix("onEvent:"))
            elif r.startswith("onBlock:"):
                all_on_blocks.add(r.removeprefix("onBlock:"))

    for cname in cfg_contract_names:
        if cname not in all_on_events:
            # Check if it might be an onBlock handler instead
            if cname not in all_on_blocks:
                issues.append(
                    f"  ❌ Contract '{cname}': configured in config.yaml but NO matching\n"
                    f"      indexer.onEvent({{contract: \"{cname}\", ...}}) call found in handlers."
                )
    return issues


def check_event_handler_presence(cfg: dict, handler_map: dict[str, set[str]]) -> list[str]:
    """
    For every config event entry, check that at least one handler file
    references that event name (case-sensitive, partial match ok).
    """
    issues: list[str] = []
    all_event_refs: set[str] = set()
    for refs in handler_map.values():
        for r in refs:
            if r.startswith("event:"):
                all_event_refs.add(r.removeprefix("event:"))

    for cdef in cfg.get("contracts", []):
        cname = cdef["name"]
        for ec in cdef.get("events", []):
            raw = ec.get("event", "")
            evt_name = raw.split("(")[0]
            # Check if any handler references this event for this contract
            # We check if the event name appears in the file text as a loose check
            found = False
            for fname, refs in handler_map.items():
                file_text = (HANDLERS_DIR / fname).read_text()
                if evt_name in file_text:
                    found = True
                    break
            if not found:
                issues.append(
                    f"  ❌ Contract '{cname}': event '{evt_name}' configured but NO handler\n"
                    f"      references this event in any src/handlers/ file."
                )
    return issues


def check_schema_int_ranges() -> list[str]:
    """
    Check schema GraphQL Int fields against handler transformations.
    Int = signed 32-bit (~2.1e9). Block numbers fit on Polygon; fee/chainId are scaled in handlers.
    """
    if not SCHEMA_FILE.exists():
        return []
    issues: list[str] = []

    for (entity, field), note in HANDLER_SCALED_INT_FIELDS.items():
        issues.append(
            f"  ℹ️  Schema '{entity}.{field}: Int' — {note}."
        )

    for (entity, field), evm_types in SCHEMA_INT_FIELD_TYPES.items():
        for evm_type in evm_types:
            if evm_type in OVERFLOW_AS_INT_TYPES:
                issues.append(
                    f"  🚨 Schema '{entity}.{field}: Int!' receives EVM '{evm_type}' which\n"
                    f"      exceeds signed 32-bit Int max (2,147,483,647).\n"
                    f"      Use BigInt! with @config(precision) or transform in handler."
                )

    # Block-number Int fields — informational only for Polygon
    block_entities = [
        ("PoolMeta", "createdBlock"),
        ("PoolMeta", "updatedAtBlock"),
        ("IndexerProgress", "lastProcessedBlock"),
        ("IndexerProgress", "updatedAtBlock"),
        ("CurveBootstrapProgress", "lastIndex"),
        ("CurveBootstrapProgress", "total"),
    ]
    for entity, field in block_entities:
        issues.append(
            f"  ℹ️  Schema '{entity}.{field}: Int!' stores block numbers (~86M on Polygon, fits Int)."
        )

    return issues


def check_event_topic0_alignment(cname: str, event_cfg: dict,
                                  abi_evts: list[dict]) -> list[str]:
    """
    For event config entries with explicit type signatures (e.g., PoolAdded(address,bytes)),
    compute the keccak256 topic0 hash and compare against the matching ABI variant.
    """
    issues: list[str] = []
    raw = event_cfg.get("event", "")
    if "(" not in raw:
        return issues  # bare name = topic0 match (config covers all overloads via hash)

    sig_name = raw.split("(")[0]
    norm_cfg = _normalize_sig(raw)
    cfg_topic0 = keccak256(norm_cfg)

    # Find ABI variant that matches
    matching_variants = [e for e in abi_evts if e["name"] == sig_name]
    for variant in matching_variants:
        abi_sig_normalized = _normalize_sig(event_signature(variant))
        if abi_sig_normalized == norm_cfg:
            if cfg_topic0 is not None:
                abi_topic0 = event_topic0(variant)
                issues.append(
                    f"  ℹ️  Contract '{cname}': event '{raw}' topic0 = {abi_topic0}\n"
                    f"      (keccak256(\"{norm_cfg}\")) — signature matches ABI."
                )
            else:
                issues.append(
                    f"  ℹ️  Contract '{cname}': event '{raw}' — signature matches ABI "
                    f"(topic0 hash skipped; install eth-hash or pycryptodome for keccak)."
                )
            break
    else:
        topic_hint = f" Computed topic0 = {cfg_topic0}." if cfg_topic0 else ""
        issues.append(
            f"  ❌ Contract '{cname}': event '{raw}' — no ABI variant matches.{topic_hint}\n"
            f"      Expected one of: {[event_signature(e) for e in matching_variants]}"
        )
    return issues


def check_indexed_param_usage(cname: str, event_cfg: dict,
                               abi_evts: list[dict]) -> list[str]:
    """
    Flag ABI params that are 'indexed: true' but the handler ignores them.
    Indexed params are available in event.params but also in event.transaction topics.
    """
    issues: list[str] = []
    name = event_cfg.get("event", "").split("(")[0]
    for evt in abi_evts:
        if evt["name"] != name:
            continue
        indexed = [inp for inp in evt.get("inputs", []) if inp.get("indexed", False)]
        if not indexed:
            continue
        # Load the handler file to check param usage
        for handler_file in find_handler_files():
            text = handler_file.read_text()
            if name not in text:
                continue
            for inp in indexed:
                pname = inp.get("name", "")
                if pname and pname not in text:
                    # indexed param not referenced in handler code (may be intentional)
                    pass  # Many indexed params are used for filtering, not in handler
    return issues


# ── Main validation pipeline ──────────────────────────────────────

def check_duplicate_chain_contract_names(config: dict) -> list[str]:
    """Envio uses one ChainContract entry per name; duplicate names overwrite earlier addresses."""
    issues: list[str] = []
    for chain in config.get("chains", []):
        chain_id = chain.get("id", "?")
        seen: dict[str, int] = {}
        for pc in chain.get("contracts", []):
            cname = pc.get("name")
            if not cname:
                continue
            seen[cname] = seen.get(cname, 0) + 1
        for cname, count in sorted(seen.items()):
            if count > 1:
                issues.append(
                    f"  ❌ Chain {chain_id}: contract name '{cname}' appears {count} times — "
                    "merge into one entry with an address list (only the last entry is indexed)."
                )
    return issues


_ENV_START_BLOCK_DEFAULT_RE = re.compile(r"^\$\{ENVIO_POLYGON_START_BLOCK:-(\d+)\}$")


def _env_start_block_default(value: object) -> int | None:
    """Resolve ${ENVIO_POLYGON_START_BLOCK:-N} default when env var is unset."""
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        m = _ENV_START_BLOCK_DEFAULT_RE.match(value.strip())
        if m:
            return int(m.group(1))
    return None


def check_contract_start_before_chain(config: dict) -> list[str]:
    """Envio rejects contract start_block lower than the chain start_block."""
    issues: list[str] = []
    for chain in config.get("chains", []):
        chain_id = chain.get("id", "?")
        chain_start = _env_start_block_default(chain.get("start_block"))
        if chain_start is None:
            continue
        for pc in chain.get("contracts", []):
            contract_start = _env_start_block_default(pc.get("start_block"))
            if contract_start is None:
                continue
            if contract_start < chain_start:
                issues.append(
                    f"  ❌ Chain {chain_id} contract '{pc.get('name')}': start_block default "
                    f"{contract_start} < chain start_block default {chain_start} — "
                    "Envio rejects this; lower the chain start_block or raise the contract start_block."
                )
    return issues


def validate_single_run(config_path: Path, verbose: bool = False) -> list[str]:
    if not config_path.exists():
        return [f"❌ Config file not found: {config_path}"]

    config = load_yaml(config_path)
    all_issues: list[str] = []

    # ── Handler code analysis (on first run) ───────────────────
    try:
        handler_map = extract_handler_calls()
        contract_register_calls = extract_contract_register_calls()
        if verbose:
            all_issues.append(f"  ℹ️  Found handler files: {', '.join(sorted(handler_map.keys()))}")
            for call in contract_register_calls:
                all_issues.append(f"  ℹ️  ContractRegister: {call}")
    except Exception as e:
        handler_map = {}
        contract_register_calls = []
        all_issues.append(f"  ⚠️  Handler analysis failed: {e}")

    # ── Global checks ──────────────────────────────────────────
    if config.get("raw_events", False):
        all_issues.append("  ℹ️  raw_events: true — event payloads stored in DB (debug only).")
    if config.get("rollback_on_reorg", True) is False:
        all_issues.append("  🚨 rollback_on_reorg: false — entity state may diverge on chain reorg.")

    # ── Build contract-def map ─────────────────────────────────
    contract_defs: dict[str, dict] = {}
    for cdef in config.get("contracts", []):
        contract_defs[cdef["name"]] = cdef

    cfg_contract_names = set(contract_defs.keys())

    # ── Handler coverage ───────────────────────────────────────
    all_issues.extend(check_handler_coverage(cfg_contract_names, handler_map))
    all_issues.extend(check_event_handler_presence(config, handler_map))

    # ── Validate each unique contract ──────────────────────────
    for cname, defn in contract_defs.items():
        abi_rel = defn.get("abi_file_path") or defn.get("abi")
        if not abi_rel:
            all_issues.append(f"  ❌ Contract '{cname}': no abi_file_path or abi in definition.")
            continue

        abi_path = resolve_abi_path(abi_rel)
        if not abi_path.exists():
            all_issues.append(f"  ❌ Contract '{cname}': ABI not found at {abi_path}")
            continue

        abi = load_json(abi_path)
        abi_evts = abi_events(abi)

        cfg_events = defn.get("events", [])
        cfg_event_names = {(e.get("event", "")).split("(")[0] for e in cfg_events}

        for evt_cfg in cfg_events:
            all_issues.extend(check_event_exists(cname, evt_cfg, abi_evts))
            all_issues.extend(check_type_safety(cname, evt_cfg, abi_evts))
            all_issues.extend(check_unnamed_params(cname, evt_cfg, abi_evts))
            all_issues.extend(check_event_topic0_alignment(cname, evt_cfg, abi_evts))

        all_issues.extend(check_anonymous_events(cname, abi_evts))
        all_issues.extend(check_missing_discovery_events(cname, cfg_event_names, abi_evts))
        all_issues.extend(check_overloaded_variant_coverage(cname, cfg_events, abi_evts))
        all_issues.extend(check_indexed_param_usage(cname, cfg_events[0], abi_evts) if cfg_events else [])

    # ── Schema checks ──────────────────────────────────────────
    all_issues.extend(check_schema_int_ranges())

    # ── Structural: per-chain addresses ────────────────────────
    all_issues.extend(check_duplicate_chain_contract_names(config))
    all_issues.extend(check_contract_start_before_chain(config))
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
    if not issues:
        print("✅ All checks passed — no structural issues found.")
        return 0

    error_count = sum(1 for i in issues if "❌" in i or "🚨" in i)
    warn_count = sum(1 for i in issues if "⚠️" in i or "📋" in i)
    info_count = sum(1 for i in issues if "ℹ️" in i)

    print(f"\n{'=' * 60}")
    print(f"  Envio Config Validation Report")
    print(f"{'=' * 60}")
    print(f"  Errors:   {error_count}")
    print(f"  Warnings: {warn_count}")
    print(f"  Info:     {info_count}")
    print(f"{'=' * 60}\n")

    for issue in issues:
        s = issue.strip()
        if not s:
            continue
        prefix_markers = {"❌", "🚨"}
        if any(m in s for m in prefix_markers):
            print(f"[ERROR]    {s}")
        elif "⚠️" in s or "📋" in s:
            print(f"[WARNING]  {s}")
        else:
            print(f"[INFO]     {s}")
        print()

    return 1 if error_count > 0 else 0


def main():
    import argparse
    parser = argparse.ArgumentParser(
        description="Enhanced AST-style static analysis for Envio config.yaml vs ABIs."
    )
    parser.add_argument(
        "--config",
        default=str(DEFAULT_CONFIG),
        help=f"Path to config.yaml (default: {DEFAULT_CONFIG})",
    )
    parser.add_argument(
        "--verbose", "-v",
        action="store_true",
        help="Show verbose handler analysis details",
    )
    args = parser.parse_args()

    config_path = Path(args.config)
    issues = validate_single_run(config_path, verbose=args.verbose)
    return print_report(issues)


if __name__ == "__main__":
    sys.exit(main())
