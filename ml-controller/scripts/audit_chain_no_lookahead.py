"""Read-only production audit for point-in-time invariants across the selection chain."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Callable

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

QueryFn = Callable[[str, list[Any] | None, float], list[dict[str, Any]]]
CANONICAL_LABEL_VERSION = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"

CHECKS: tuple[tuple[str, str, list[Any]], ...] = (
    ("active8_oof", """
        SELECT COUNT(*) AS violations FROM active8_oof_predictions
         WHERE train_end >= prediction_date
            OR test_start > prediction_date
            OR test_end < prediction_date
            OR label_known_date <= prediction_date
    """, []),
    ("l4_oof", """
        SELECT COUNT(*) AS violations FROM l4_oof_predictions
         WHERE trained_until >= prediction_date
    """, []),
    ("allocator_oof", """
        SELECT COUNT(*) AS violations FROM allocator_ev_oof_snapshots
         WHERE s12_asof_date > snapshot_date
            OR label_known_date <= snapshot_date
    """, []),
    ("price_horizon", """
        SELECT COUNT(*) AS violations FROM price_horizon_labels_v1
         WHERE entry_date <= price_date
            OR exit_date < entry_date
            OR outcome_known_date < exit_date
    """, []),
    ("fundamental_pit", """
        SELECT COUNT(*) AS violations FROM canonical_fundamental_features
         WHERE available_date > as_of_date
    """, []),
    ("allocator_native_l4", """
        SELECT COUNT(*) AS violations FROM allocator_ev_feature_snapshots
         WHERE json_extract(alpha_allocation,'$.l4_alpha_ev.trained_until') IS NOT NULL
           AND json_extract(alpha_allocation,'$.l4_alpha_ev.trained_until') >= snapshot_date
    """, []),
    ("allocator_native_source_date", """
        SELECT COUNT(*) AS violations FROM allocator_ev_feature_snapshots
         WHERE source_recommendation_date IS NOT NULL
           AND source_recommendation_date > snapshot_date
    """, []),
    ("s12_outcome_known", """
        SELECT COUNT(*) AS violations FROM s12_replay_trade_outcomes
         WHERE sample_eligible=1
           AND (
             json_extract(detail_json,'$.replay_diagnostics.outcome_known_date') IS NULL
             OR json_extract(detail_json,'$.replay_diagnostics.outcome_known_date') <= COALESCE(signal_date,trade_date)
           )
    """, []),
    ("canonical_prediction_label", """
        SELECT COUNT(*) AS violations FROM predictions
         WHERE verification_label_schema_version=?
           AND (
             prediction_date IS NULL
             OR verification_label_end_date < prediction_date
             OR verification_label_known_date <= prediction_date
           )
    """, [CANONICAL_LABEL_VERSION]),
)


def run_audit(query_fn: QueryFn) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    for name, sql, params in CHECKS:
        try:
            rows = query_fn(sql, params or None, 120.0)
            if not rows or "violations" not in rows[0]:
                raise RuntimeError("missing_violation_count")
            violations = int(rows[0]["violations"])
            checks.append({
                "name": name,
                "violations": violations,
                "status": "PASS" if violations == 0 else "FAIL",
            })
        except Exception as exc:
            checks.append({
                "name": name,
                "violations": None,
                "status": "ERROR",
                "error": f"{type(exc).__name__}:{exc}",
            })
    failed = [row["name"] for row in checks if row["status"] != "PASS"]
    return {
        "schema_version": "selection-chain-no-lookahead-audit-v1",
        "decision": "PASS" if not failed else "FAIL",
        "failed_checks": failed,
        "checks": checks,
    }


# Keep the operational CLI on the same fail-closed contract used by runtime.
from services.no_lookahead_audit import CHECKS, run_audit


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pretty", action="store_true")
    args = parser.parse_args()
    from services.d1_client import query

    result = run_audit(query)
    print(json.dumps(result, ensure_ascii=False, indent=2 if args.pretty else None))
    return 0 if result["decision"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())