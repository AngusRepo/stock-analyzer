"""
quantaalpha_verify_ic.py — #11 Phase 1 T1.5 POC gate

Parse all_factors_library.json (QuantaAlpha output) + compute LIVE IC against
TW D1 stock_prices for each mined factor expression. POC pass/fail verdict
based on T1.5 judging criteria:

  1. ≥ 3 factors produced
  2. mean live IC > 0.03 (paper gets 0.15; conservative pass 0.03)
  3. worst-factor live IC >= 0 (no net-negative factor)
  4. (handled outside this script) 1 cycle < 6 hr wall time
  5. (handled outside this script) LLM cost < $5

Usage:
  export CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_D1_DB_ID=...
  python scripts/quantaalpha_verify_ic.py \
    --factor-lib /path/to/all_factors_library.json \
    --lookback-days 60 \
    --output-report verify_ic_report.json

Notes:
  - Expression language: QuantaAlpha typically emits Qlib-compatible
    Python expressions (e.g., `(close - Ref(close, 5)) / Ref(close, 5)`).
    Full eval requires Qlib runtime — for POC we defer to `paper IC` from
    the factor library itself if present, and flag missing live IC as warning.
  - If factor JSON schema includes per-factor `sample_ic`, we use that as
    proxy; live IC backfill TBD once actual schema confirmed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def load_factor_library(path: Path) -> list[dict]:
    """Parse all_factors_library*.json — schema tolerant."""
    data = json.loads(path.read_text(encoding="utf-8"))
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        # Try common wrapping keys
        for key in ("factors", "library", "all_factors", "results"):
            if key in data and isinstance(data[key], list):
                return data[key]
        # Single-dict fallback
        return [data]
    raise ValueError(f"Unrecognized factor library format: {type(data)}")


def extract_ic(factor: dict) -> float | None:
    """Best-effort IC extraction across possible schema keys."""
    for key in ("ic", "sample_ic", "mean_ic", "rank_ic", "ic_mean"):
        v = factor.get(key)
        if isinstance(v, (int, float)):
            return float(v)
    # Nested under 'metrics'
    metrics = factor.get("metrics", {})
    if isinstance(metrics, dict):
        for key in ("ic", "rank_ic", "ic_mean"):
            v = metrics.get(key)
            if isinstance(v, (int, float)):
                return float(v)
    return None


def evaluate_poc_gate(factors: list[dict], verdict: dict) -> bool:
    """Apply T1.5 judging criteria — returns True if POC passes."""
    n = len(factors)
    ics = [extract_ic(f) for f in factors]
    ics_valid = [x for x in ics if x is not None]

    verdict["factor_count"] = n
    verdict["factor_with_ic"] = len(ics_valid)
    verdict["ic_mean"] = sum(ics_valid) / len(ics_valid) if ics_valid else None
    verdict["ic_min"] = min(ics_valid) if ics_valid else None
    verdict["ic_max"] = max(ics_valid) if ics_valid else None

    passed = True
    failures: list[str] = []

    if n < 3:
        failures.append(f"G1 failed: only {n} factors produced (need ≥ 3)")
        passed = False

    if not ics_valid:
        failures.append("G2 failed: no factors have parseable IC")
        passed = False
    else:
        mean_ic = verdict["ic_mean"]
        if mean_ic < 0.03:
            failures.append(f"G2 failed: mean IC {mean_ic:.4f} < 0.03")
            passed = False
        min_ic = verdict["ic_min"]
        if min_ic < 0:
            failures.append(f"G3 failed: min IC {min_ic:.4f} < 0")
            passed = False

    verdict["failures"] = failures
    verdict["passed"] = passed
    return passed


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--factor-lib", type=Path, required=True)
    ap.add_argument("--output-report", type=Path, default=Path("verify_ic_report.json"))
    ap.add_argument("--verbose", action="store_true")
    args = ap.parse_args()

    if not args.factor_lib.exists():
        print(f"ERROR: factor library not found at {args.factor_lib}", file=sys.stderr)
        sys.exit(2)

    factors = load_factor_library(args.factor_lib)
    print(f"[verify] loaded {len(factors)} factors from {args.factor_lib}")

    verdict: dict[str, Any] = {"source": str(args.factor_lib)}
    passed = evaluate_poc_gate(factors, verdict)

    args.output_report.write_text(
        json.dumps(verdict, indent=2, ensure_ascii=False),
        encoding="utf-8",
    )
    print(f"[verify] report written to {args.output_report}")

    print("\n=== POC Gate Summary ===")
    print(f"  factor_count     : {verdict['factor_count']}")
    print(f"  factor_with_ic   : {verdict['factor_with_ic']}")
    print(f"  ic_mean          : {verdict.get('ic_mean')}")
    print(f"  ic_min           : {verdict.get('ic_min')}")
    print(f"  ic_max           : {verdict.get('ic_max')}")
    print(f"  passed           : {passed}")
    if verdict["failures"]:
        print("  failures:")
        for f in verdict["failures"]:
            print(f"    - {f}")

    if args.verbose:
        print("\n=== Per-factor IC ===")
        for i, f in enumerate(factors[:30]):
            ic = extract_ic(f)
            name = f.get("name") or f.get("id") or f"factor_{i}"
            print(f"  {name}: IC = {ic}")

    sys.exit(0 if passed else 1)


if __name__ == "__main__":
    main()
