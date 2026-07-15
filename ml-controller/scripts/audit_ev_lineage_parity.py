from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import d1_client  # noqa: E402
from services.ev_lineage_contract import (  # noqa: E402
    canonical_ev_feature_values,
    ev_feature_lineage_blockers,
    load_model_champion_history,
    reconstruct_point_in_time_ev_lineage,
)


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _legacy_projection(row: dict[str, Any]) -> dict[str, Any]:
    score = _loads(row.get("score_components"))
    forecast = _loads(row.get("forecast_data"))
    ensemble = forecast.get("ensemble_v2") if isinstance(forecast.get("ensemble_v2"), dict) else {}
    score.pop("semanticVersion", None)
    for key in ("semantic_version", "artifact_versions", "model_set_signature", "lineage_status", "lineage_blockers"):
        ensemble.pop(key, None)
    forecast["ensemble_v2"] = ensemble
    return {
        **row,
        "score_components": json.dumps(score, ensure_ascii=False, separators=(",", ":")),
        "forecast_data": json.dumps(forecast, ensure_ascii=False, separators=(",", ":")),
    }


def _rows(start_date: str, end_date: str) -> list[dict[str, Any]]:
    return d1_client.query(
        """
        WITH latest AS (
          SELECT p.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.stock_id, date(p.prediction_date)
                   ORDER BY datetime(p.generated_at) DESC, p.id DESC
                 ) AS rn
          FROM predictions p
          WHERE p.model_name = 'ensemble'
            AND date(p.prediction_date) BETWEEN date(?) AND date(?)
        )
        SELECT p.stock_id, s.symbol, date(p.prediction_date) AS prediction_date,
               p.generated_at AS prediction_generated_at, p.forecast_data,
               dr.score, dr.score_components
        FROM latest p
        JOIN daily_recommendations dr
          ON dr.stock_id = p.stock_id AND date(dr.date) = date(p.prediction_date)
        JOIN stocks s ON s.id = p.stock_id
        WHERE p.rn = 1
        ORDER BY date(p.prediction_date), s.symbol
        """,
        [start_date, end_date],
        timeout=120,
    )


def audit(start_date: str, end_date: str) -> dict[str, Any]:
    rows = _rows(start_date, end_date)
    generated = sorted(str(row.get("prediction_generated_at") or "") for row in rows if row.get("prediction_generated_at"))
    events, history_load = load_model_champion_history(
        d1_client.query,
        start_at=generated[0] if generated else f"{start_date}T00:00:00Z",
        end_at=generated[-1] if generated else f"{end_date}T23:59:59Z",
    )
    by_date: dict[str, dict[str, Any]] = {}
    native_blockers: Counter[str] = Counter()
    reconstruction_blockers: Counter[str] = Counter()
    mismatch_examples: list[dict[str, Any]] = []
    native_blocker_examples: list[dict[str, Any]] = []
    for row in rows:
        day = str(row.get("prediction_date") or "unknown")
        day_audit = by_date.setdefault(day, {
            "input_rows": 0,
            "expected_filtered_rows": 0,
            "eligible_rows": 0,
            "native_valid_rows": 0,
            "reconstructed_rows": 0,
            "parity_match_rows": 0,
            "parity_mismatch_rows": 0,
        })
        day_audit["input_rows"] += 1
        score_payload = _loads(row.get("score_components"))
        if (
            str(score_payload.get("version") or "") == "score_v2_filtered_v1"
            and score_payload.get("eligibleForAllocation") in (False, 0)
        ):
            day_audit["expected_filtered_rows"] += 1
            continue
        day_audit["eligible_rows"] += 1
        blockers = ev_feature_lineage_blockers(row)
        if blockers:
            native_blockers.update(blockers)
            if len(native_blocker_examples) < 25:
                native_blocker_examples.append({
                    "date": day,
                    "symbol": row.get("symbol"),
                    "blockers": blockers,
                    "score_components": _loads(row.get("score_components")),
                })
            continue
        day_audit["native_valid_rows"] += 1
        native_features = canonical_ev_feature_values(row)
        result = reconstruct_point_in_time_ev_lineage(
            _legacy_projection(row),
            champion_events=events,
        )
        if result.get("status") != "reconstructed" or not isinstance(result.get("row"), dict):
            reconstruction_blockers.update(result.get("blockers") or ["unknown"])
            continue
        day_audit["reconstructed_rows"] += 1
        reconstructed_features = canonical_ev_feature_values(result["row"])
        if reconstructed_features == native_features:
            day_audit["parity_match_rows"] += 1
        else:
            day_audit["parity_mismatch_rows"] += 1
            if len(mismatch_examples) < 10:
                mismatch_examples.append({
                    "date": day,
                    "symbol": row.get("symbol"),
                    "native": native_features,
                    "reconstructed": reconstructed_features,
                })
    passed = bool(rows) and all(
        values["input_rows"] == values["eligible_rows"] + values["expected_filtered_rows"]
        and values["eligible_rows"] == values["native_valid_rows"] == values["reconstructed_rows"] == values["parity_match_rows"]
        and values["parity_mismatch_rows"] == 0
        for values in by_date.values()
    )
    return {
        "schema_version": "ev-lineage-native-parity-audit-v1",
        "status": "PASS" if passed else "FAIL",
        "start_date": start_date,
        "end_date": end_date,
        "history_load": history_load,
        "champion_event_count": len(events),
        "input_rows": len(rows),
        "dates": by_date,
        "native_blocker_counts": dict(sorted(native_blockers.items())),
        "native_blocker_examples": native_blocker_examples,
        "reconstruction_blocker_counts": dict(sorted(reconstruction_blockers.items())),
        "mismatch_examples": mismatch_examples,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.start_date, args.end_date), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
