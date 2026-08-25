from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services.d1_domain_client import D1DataDomain, client_proxy_for_domain  # noqa: E402

CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)
MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)
LEARNING_D1_CLIENT = client_proxy_for_domain(D1DataDomain.LEARNING)
from services.ev_lineage_contract import (  # noqa: E402
    attach_next_session_open_evidence,
    attach_same_run_model_version_evidence,
    load_model_champion_history,
    reconstruct_point_in_time_ev_lineage,
)


def _candidate_rows(start_date: str, end_date: str) -> list[dict[str, Any]]:
    predictions = LEARNING_D1_CLIENT.query(
        """WITH latest AS (
             SELECT p.*, ROW_NUMBER() OVER (
               PARTITION BY p.stock_id, date(p.prediction_date)
               ORDER BY datetime(p.generated_at) DESC, p.id DESC
             ) rn
             FROM predictions p
             WHERE p.model_name='ensemble'
               AND date(p.prediction_date) BETWEEN date(?) AND date(?)
           )
           SELECT stock_id, date(prediction_date) prediction_date,
                  generated_at prediction_generated_at, forecast_data
           FROM latest WHERE rn=1""",
        [start_date, end_date],
        timeout=120,
    )
    core_rows = CORE_D1_CLIENT.query(
        """SELECT dr.stock_id, date(dr.date) prediction_date, s.symbol,
                  dr.score, dr.score_components, dr.alpha_context,
                  dr.alpha_allocation, dr.market_segment, dr.recommendation_lane
             FROM daily_recommendations dr
             JOIN stocks s ON s.id=dr.stock_id
            WHERE date(dr.date) BETWEEN date(?) AND date(?)""",
        [start_date, end_date],
        timeout=120,
    )
    core_by_key = {
        (int(row["stock_id"]), str(row["prediction_date"])[:10]): row
        for row in core_rows if row.get("stock_id") is not None
    }
    rows = [
        {**prediction, **core_by_key[key]}
        for prediction in predictions
        if prediction.get("stock_id") is not None
        and (key := (int(prediction["stock_id"]), str(prediction.get("prediction_date") or "")[:10])) in core_by_key
    ]
    timed, _ = attach_next_session_open_evidence(MARKET_D1_CLIENT.query, rows)
    enriched, _ = attach_same_run_model_version_evidence(LEARNING_D1_CLIENT.query, timed)
    return enriched

def _row_evidence(candidate_rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, int]]:
    evidence_rows: list[dict[str, Any]] = []
    signal_dates = sorted({str(row.get("prediction_date") or "")[:10] for row in candidate_rows})
    for signal_date in signal_dates:
        evidence_rows.extend(LEARNING_D1_CLIENT.query(
            """WITH outcomes AS (
                 SELECT symbol,
                        MAX(CASE WHEN outcome_known_date IS NOT NULL THEN 1 ELSE 0 END) five_session_mature,
                        MAX(CASE WHEN residual_return_net IS NOT NULL THEN 1 ELSE 0 END) canonical_label_eligible
                   FROM canonical_selection_outcomes_v1
                  WHERE signal_date=? AND horizon_days=5
                  GROUP BY symbol
               ), replay AS (
                 SELECT symbol,
                        MAX(CASE WHEN json_extract(detail_json, '$.replay_diagnostics.outcome_known_date') IS NOT NULL THEN 1 ELSE 0 END) v3_known,
                        MAX(CASE WHEN sample_eligible=1 AND pnl_pct IS NOT NULL THEN 1 ELSE 0 END) v3_executed
                   FROM s12_replay_trade_outcomes
                  WHERE signal_date=? AND source='s12_multisession_structure_replay_v3'
                  GROUP BY symbol
               ), structures AS (
                 SELECT symbol, 1 structure_available
                   FROM s12_structure_snapshots WHERE trade_date=? GROUP BY symbol
               )
               SELECT ? signal_date, o.symbol, o.five_session_mature,
                      o.canonical_label_eligible, COALESCE(r.v3_known,0) v3_known,
                      COALESCE(r.v3_executed,0) v3_executed,
                      COALESCE(s.structure_available,0) structure_available
                 FROM outcomes o
                 LEFT JOIN replay r ON r.symbol=o.symbol
                 LEFT JOIN structures s ON s.symbol=o.symbol
                ORDER BY o.symbol""",
            [signal_date, signal_date, signal_date, signal_date],
            timeout=120,
        ))
    return {
        (str(row.get("signal_date")), str(row.get("symbol"))): {
            key: int(row.get(key) or 0)
            for key in ("five_session_mature", "canonical_label_eligible", "v3_known", "v3_executed", "structure_available")
        }
        for row in evidence_rows
    }


def audit(start_date: str, end_date: str) -> dict[str, Any]:
    rows = _candidate_rows(start_date, end_date)
    generated = sorted(
        str(row.get("prediction_generated_at") or "").strip()
        for row in rows
        if str(row.get("prediction_generated_at") or "").strip()
    )
    events, history_load = load_model_champion_history(
        LEARNING_D1_CLIENT.query,
        start_at=generated[0] if generated else f"{start_date}T00:00:00Z",
        end_at=generated[-1] if generated else f"{end_date}T23:59:59Z",
    )
    evidence = _row_evidence(rows)
    by_date: dict[str, dict[str, Any]] = {}
    total_blockers: Counter[str] = Counter()
    for row in rows:
        day = str(row.get("prediction_date") or "unknown")[:10]
        result = reconstruct_point_in_time_ev_lineage(row, champion_events=events)
        status = str(result.get("status") or "rejected")
        entry = by_date.setdefault(
            day,
            {
                "input_rows": 0,
                "native_rows": 0,
                "reconstructed_rows": 0,
                "rejected_rows": 0,
                "five_session_mature_rows": 0,
                "canonical_label_eligible_rows": 0,
                "v3_known_rows": 0,
                "v3_executed_rows": 0,
                "structure_rows": 0,
                "accepted_mature_rows": 0,
                "accepted_canonical_label_rows": 0,
                "accepted_v3_known_rows": 0,
                "accepted_v3_executed_rows": 0,
                "accepted_structure_rows": 0,
                "blocker_counts": Counter(),
            },
        )
        entry["input_rows"] += 1
        row_evidence = evidence.get((day, str(row.get("symbol") or "")), {})
        entry["five_session_mature_rows"] += int(row_evidence.get("five_session_mature") or 0)
        entry["canonical_label_eligible_rows"] += int(row_evidence.get("canonical_label_eligible") or 0)
        entry["v3_known_rows"] += int(row_evidence.get("v3_known") or 0)
        entry["v3_executed_rows"] += int(row_evidence.get("v3_executed") or 0)
        entry["structure_rows"] += int(row_evidence.get("structure_available") or 0)
        if status == "native":
            entry["native_rows"] += 1
        elif status == "reconstructed":
            entry["reconstructed_rows"] += 1
        else:
            entry["rejected_rows"] += 1
            blockers = [str(value) for value in (result.get("blockers") or ["unknown"])]
            entry["blocker_counts"].update(blockers)
            total_blockers.update(blockers)
        if status in {"native", "reconstructed"}:
            entry["accepted_mature_rows"] += int(row_evidence.get("five_session_mature") or 0)
            entry["accepted_canonical_label_rows"] += int(row_evidence.get("canonical_label_eligible") or 0)
            entry["accepted_v3_known_rows"] += int(row_evidence.get("v3_known") or 0)
            entry["accepted_v3_executed_rows"] += int(row_evidence.get("v3_executed") or 0)
            entry["accepted_structure_rows"] += int(row_evidence.get("structure_available") or 0)

    results: list[dict[str, Any]] = []
    for day, entry in sorted(by_date.items()):
        accepted = int(entry["native_rows"]) + int(entry["reconstructed_rows"])
        mature = int(entry["accepted_mature_rows"])
        canonical_labels = int(entry["accepted_canonical_label_rows"])
        v3_known = int(entry["accepted_v3_known_rows"])
        results.append(
            {
                "date": day,
                "input_rows": int(entry["input_rows"]),
                "accepted_lineage_rows": accepted,
                "native_rows": int(entry["native_rows"]),
                "reconstructed_rows": int(entry["reconstructed_rows"]),
                "rejected_rows": int(entry["rejected_rows"]),
                "acceptance_coverage": round(accepted / max(1, int(entry["input_rows"])), 8),
                "candidate_rows": int(entry["input_rows"]),
                "five_session_mature_rows": int(entry["five_session_mature_rows"]),
                "canonical_label_eligible_rows": int(entry["canonical_label_eligible_rows"]),
                "v3_known_rows": int(entry["v3_known_rows"]),
                "v3_executed_rows": int(entry["v3_executed_rows"]),
                "structure_rows": int(entry["structure_rows"]),
                "accepted_mature_rows": mature,
                "accepted_canonical_label_rows": canonical_labels,
                "accepted_v3_known_rows": v3_known,
                "accepted_v3_executed_rows": int(entry["accepted_v3_executed_rows"]),
                "accepted_structure_rows": int(entry["accepted_structure_rows"]),
                "selection_backfill_eligible": accepted >= 20 and mature >= 20 and canonical_labels >= 20,
                "s12_v3_backfill_eligible": accepted >= 20 and mature >= 20 and canonical_labels >= 20 and v3_known >= 20,
                "blocker_counts": dict(entry["blocker_counts"].most_common(8)),
            }
        )
    return {
        "schema_version": "historical-ev-backfill-eligibility-audit-v1",
        "start_date": start_date,
        "end_date": end_date,
        "input_rows": len(rows),
        "champion_event_count": len(events),
        "history_load": history_load,
        "eligible_selection_dates": [row["date"] for row in results if row["selection_backfill_eligible"]],
        "eligible_s12_v3_dates": [row["date"] for row in results if row["s12_v3_backfill_eligible"]],
        "total_blocker_counts": dict(total_blockers.most_common()),
        "dates": results,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--start-date", required=True)
    parser.add_argument("--end-date", required=True)
    args = parser.parse_args()
    print(json.dumps(audit(args.start_date, args.end_date), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
