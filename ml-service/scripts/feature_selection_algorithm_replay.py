"""Offline feature-selection algorithm profile replay.

Run from repo root or ml-service with the project environment configured:

    python ml-service/scripts/feature_selection_algorithm_replay.py \
      --profiles current,candidate_v2 --dry-run

The script intentionally calls the normal pipeline path with dry_run=True by
default. It does not promote artifacts; it only emits comparable evidence.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path
from typing import Any


def _repo_ml_service_root() -> Path:
    here = Path(__file__).resolve()
    return here.parents[1]


def _json_default(value: Any) -> Any:
    try:
        import numpy as np

        if isinstance(value, np.generic):
            return value.item()
        if isinstance(value, np.ndarray):
            return value.tolist()
    except Exception:
        pass
    if isinstance(value, (set, tuple)):
        return list(value)
    return str(value)


def _profile_payload(profile: str, base: dict[str, Any]) -> dict[str, Any]:
    payload = dict(base)
    payload["algorithm_profile"] = profile
    return payload


def _get_nested(data: dict[str, Any], path: tuple[str, ...], default: Any = None) -> Any:
    current: Any = data
    for key in path:
        if not isinstance(current, dict):
            return default
        current = current.get(key)
    return default if current is None else current


def _as_int(value: Any, default: int = 0) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def _as_float(value: Any, default: float = 0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _has_value(value: Any) -> bool:
    return value is not None and value != ""


def summarize_pipeline_result(result: dict[str, Any], *, elapsed_s: float) -> dict[str, Any]:
    pool = result.get("feature_pool", {}) if isinstance(result, dict) else {}
    tree_active = pool.get("tree_active") or pool.get("active") or []
    reserve = pool.get("reserve") or []
    evidence = result.get("algorithm_evidence") or {}
    k_sweep = evidence.get("k_sweep") or result.get("k_sweep") or {}
    final_oos = result.get("final_oos_audit") or {}
    signal_gate = result.get("signal_gate") or {}

    return {
        "elapsed_s": round(float(elapsed_s), 3),
        "error": result.get("error") if isinstance(result, dict) else "invalid_result",
        "active_count": len(tree_active),
        "reserve_count": len(reserve),
        "algorithm_profile": evidence.get("algorithm_profile") or result.get("algorithm_profile"),
        "k_sweep": {
            "sampler": k_sweep.get("sampler"),
            "objective_mode": k_sweep.get("objective_mode"),
            "knee_policy": k_sweep.get("knee_policy"),
            "knee_method": k_sweep.get("knee_method"),
            "best_k": k_sweep.get("best_k"),
            "best_ic": k_sweep.get("best_ic"),
            "actual_trials": k_sweep.get("actual_trials"),
            "unique_k_evaluated": k_sweep.get("unique_k_evaluated"),
        },
        "final_oos_audit": {
            "stable_count": final_oos.get("stable_count"),
            "total": final_oos.get("total"),
            "used_for_selection": final_oos.get("used_for_selection"),
        },
        "signal_gate": {
            "passed": signal_gate.get("passed"),
            "p_value": signal_gate.get("p_value"),
        },
        "algorithm_evidence": evidence,
    }


def build_profile_comparison(
    replay_result: dict[str, Any],
    *,
    baseline: str = "current",
    candidate: str = "candidate_v2",
    min_final_oos_stable_delta: int = 0,
    max_active_growth_ratio: float = 1.5,
    min_best_ic_delta: float = 0.0,
) -> dict[str, Any]:
    profiles = replay_result.get("profiles") or {}
    base = profiles.get(baseline) or {}
    cand = profiles.get(candidate) or {}
    base_active = _as_int(base.get("active_count"))
    cand_active = _as_int(cand.get("active_count"))
    base_oos = _as_int(_get_nested(base, ("final_oos_audit", "stable_count"), None), default=-1)
    cand_oos = _as_int(_get_nested(cand, ("final_oos_audit", "stable_count"), None), default=-1)
    base_ic = _as_float(_get_nested(base, ("k_sweep", "best_ic"), None))
    cand_ic = _as_float(_get_nested(cand, ("k_sweep", "best_ic"), None))
    base_objective = _get_nested(base, ("k_sweep", "objective_mode"))
    cand_objective = _get_nested(cand, ("k_sweep", "objective_mode"))
    base_k_best = _get_nested(base, ("k_sweep", "best_k"), None)
    cand_k_best = _get_nested(cand, ("k_sweep", "best_k"), None)
    base_oos_total = _get_nested(base, ("final_oos_audit", "total"), None)
    cand_oos_total = _get_nested(cand, ("final_oos_audit", "total"), None)
    objective_comparable = bool(base_objective and base_objective == cand_objective)
    active_growth_ratio = (
        cand_active / max(base_active, 1)
        if base_active > 0 and cand_active > 0
        else None
    )
    best_ic_delta = round(cand_ic - base_ic, 6)
    final_oos_stable_delta = cand_oos - base_oos

    checks = {
        "profiles_present": bool(base) and bool(cand),
        "profiles_error_free": not base.get("error") and not cand.get("error"),
        "baseline_profile_matches": base.get("algorithm_profile") == baseline,
        "candidate_profile_matches": cand.get("algorithm_profile") == candidate,
        "baseline_signal_gate_passed": base.get("signal_gate", {}).get("passed") is True,
        "candidate_signal_gate_passed": cand.get("signal_gate", {}).get("passed") is True,
        "k_sweep_evidence_complete": bool(base_objective)
        and bool(cand_objective)
        and _has_value(base_k_best)
        and _has_value(cand_k_best),
        "final_oos_evidence_complete": base_oos >= 0
        and cand_oos >= 0
        and _has_value(base_oos_total)
        and _has_value(cand_oos_total),
        "candidate_final_oos_not_worse": cand_oos >= 0
        and base_oos >= 0
        and final_oos_stable_delta >= int(min_final_oos_stable_delta),
        "active_growth_within_limit": active_growth_ratio is not None
        and active_growth_ratio <= float(max_active_growth_ratio),
        "best_ic_not_worse_if_comparable": (
            best_ic_delta >= float(min_best_ic_delta) if objective_comparable else True
        ),
    }
    evidence_required = [
        "profiles_present",
        "profiles_error_free",
        "baseline_profile_matches",
        "candidate_profile_matches",
        "baseline_signal_gate_passed",
        "candidate_signal_gate_passed",
        "k_sweep_evidence_complete",
        "final_oos_evidence_complete",
    ]
    promotion_required = [
        *evidence_required,
        "candidate_final_oos_not_worse",
        "active_growth_within_limit",
        "best_ic_not_worse_if_comparable",
    ]
    missing_evidence = [name for name in evidence_required if not checks[name]]
    passed = all(checks[name] for name in promotion_required)
    if missing_evidence:
        recommendation = "blocked"
    elif passed and objective_comparable:
        recommendation = "candidate_replay_passed"
    elif passed:
        recommendation = "candidate_replay_passed_with_noncomparable_ic"
    else:
        recommendation = "candidate_replay_failed"

    return {
        "baseline": baseline,
        "candidate": candidate,
        "recommendation": recommendation,
        "promotion_ready": bool(passed),
        "objective_comparable": objective_comparable,
        "thresholds": {
            "min_final_oos_stable_delta": int(min_final_oos_stable_delta),
            "max_active_growth_ratio": float(max_active_growth_ratio),
            "min_best_ic_delta": float(min_best_ic_delta),
        },
        "deltas": {
            "active_count": cand_active - base_active,
            "active_growth_ratio": round(active_growth_ratio, 6) if active_growth_ratio is not None else None,
            "final_oos_stable_count": final_oos_stable_delta,
            "best_ic": best_ic_delta,
        },
        "checks": checks,
        "missing_evidence": missing_evidence,
        "caveats": [
            "k_sweep_best_ic_objective_differs; use final_oos_audit for promotion gate"
        ] if not objective_comparable else [],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Replay feature-selection algorithm profiles.")
    parser.add_argument("--profiles", default="current,candidate_v2", help="Comma-separated profile names.")
    parser.add_argument("--baseline", default="current", help="Baseline profile name for comparison.")
    parser.add_argument("--candidate", default="candidate_v2", help="Candidate profile name for comparison.")
    parser.add_argument("--payload-json", default="", help="Optional JSON payload file with selection overrides.")
    parser.add_argument("--train-end-date", default="", help="Optional walk-forward train_end_date.")
    parser.add_argument("--gcs-prefix", default="", help="Optional walk-forward GCS prefix.")
    parser.add_argument("--output", default="", help="Optional output JSON file.")
    parser.add_argument("--dry-run", action="store_true", default=True, help="Keep dry-run enabled.")
    parser.add_argument("--allow-write", action="store_true", help="Disable dry-run and allow GCS writes.")
    parser.add_argument("--min-final-oos-stable-delta", type=int, default=0)
    parser.add_argument("--max-active-growth-ratio", type=float, default=1.5)
    parser.add_argument("--min-best-ic-delta", type=float, default=0.0)
    args = parser.parse_args()

    sys.path.insert(0, str(_repo_ml_service_root()))
    from app.feature_selection import run_feature_selection_pipeline

    base_payload: dict[str, Any] = {}
    if args.payload_json:
        base_payload = json.loads(Path(args.payload_json).read_text(encoding="utf-8"))
    if args.train_end_date:
        base_payload["train_end_date"] = args.train_end_date
    if args.gcs_prefix:
        base_payload["gcs_prefix"] = args.gcs_prefix

    dry_run = bool(args.dry_run and not args.allow_write)
    profiles = [part.strip() for part in args.profiles.split(",") if part.strip()]
    results = {
        "schema_version": "feature-selection-algorithm-replay-v1",
        "started_at_epoch": time.time(),
        "dry_run": dry_run,
        "profiles": {},
    }
    os.environ.setdefault("FEATURE_SELECTION_STAGE_CHECKPOINTS", "0")

    for profile in profiles:
        payload = _profile_payload(profile, base_payload)
        started = time.time()
        result = run_feature_selection_pipeline(
            dry_run=dry_run,
            train_end_date=payload.pop("train_end_date", None),
            gcs_prefix=payload.pop("gcs_prefix", None),
            **payload,
        )
        results["profiles"][profile] = summarize_pipeline_result(result, elapsed_s=time.time() - started)

    results["comparison"] = build_profile_comparison(
        results,
        baseline=args.baseline,
        candidate=args.candidate,
        min_final_oos_stable_delta=args.min_final_oos_stable_delta,
        max_active_growth_ratio=args.max_active_growth_ratio,
        min_best_ic_delta=args.min_best_ic_delta,
    )

    text = json.dumps(results, ensure_ascii=False, indent=2, default=_json_default)
    if args.output:
        Path(args.output).write_text(text, encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
