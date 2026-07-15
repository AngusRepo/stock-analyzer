from __future__ import annotations

import argparse
import json
import sys
from collections import Counter
from datetime import date, timedelta
from pathlib import Path
from typing import Any


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from services import d1_client  # noqa: E402
from services.ev_lineage_contract import (  # noqa: E402
    attach_next_session_open_evidence,
    attach_same_run_model_version_evidence,
    load_model_champion_history,
    reconstruct_point_in_time_ev_lineage,
)


def _candidate_rows(start_date: str, end_date: str) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    current = date.fromisoformat(start_date)
    final = date.fromisoformat(end_date)
    while current <= final:
        signal_date = current.isoformat()
        next_date = (current + timedelta(days=1)).isoformat()
        rows.extend(d1_client.query(
            """
        WITH latest AS (
          SELECT p.*,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.stock_id, date(p.prediction_date)
                   ORDER BY datetime(p.generated_at) DESC, p.id DESC
                 ) AS rn
            FROM predictions p
           WHERE p.model_name = 'ensemble'
             AND p.prediction_date >= ?
             AND p.prediction_date < ?
        )
        SELECT p.stock_id,
               st.symbol,
               date(p.prediction_date) AS prediction_date,
               p.generated_at AS prediction_generated_at,
               p.forecast_data,
               dr.score,
               dr.score_components,
               dr.alpha_context,
               dr.alpha_allocation,
               dr.market_segment,
               dr.recommendation_lane
          FROM latest p
          JOIN daily_recommendations dr
            ON dr.stock_id = p.stock_id
           AND date(dr.date) = date(p.prediction_date)
          JOIN stocks st ON st.id = p.stock_id
         WHERE p.rn = 1
         ORDER BY date(p.prediction_date), st.symbol
            """,
            [signal_date, next_date],
            timeout=120,
        ))
        current += timedelta(days=1)
    timed, _ = attach_next_session_open_evidence(d1_client.query, rows)
    enriched, _ = attach_same_run_model_version_evidence(d1_client.query, timed)
    return enriched


def _row_evidence(candidate_rows: list[dict[str, Any]]) -> dict[tuple[str, str], dict[str, int]]:
    evidence_rows: list[dict[str, Any]] = []
    signal_dates = sorted({str(row.get("prediction_date") or "")[:10] for row in candidate_rows})
    for signal_date in signal_dates:
        end_date = (date.fromisoformat(signal_date) + timedelta(days=40)).isoformat()
        evidence_rows.extend(d1_client.query(
            """
        WITH candidate AS (
          SELECT p.stock_id,
                 st.symbol,
                 ROW_NUMBER() OVER (
                   PARTITION BY p.stock_id
                   ORDER BY datetime(p.generated_at) DESC, p.id DESC
                 ) AS rn
            FROM predictions p
            JOIN stocks st ON st.id = p.stock_id
           WHERE p.model_name = 'ensemble'
             AND p.prediction_date >= ?
             AND p.prediction_date < ?
        ), price_series AS (
          SELECT sp.stock_id,
                 date(sp.date) AS price_date,
                 sp.open,
                 sp.close,
                 CASE
                   WHEN cmd.close > 0 AND cmd.adj_close > 0
                   THEN cmd.adj_close / cmd.close
                 END AS adjustment_factor
            FROM stock_prices sp
            JOIN candidate c ON c.stock_id = sp.stock_id AND c.rn = 1
            JOIN stocks factor_stock ON factor_stock.id = sp.stock_id
            LEFT JOIN canonical_market_daily cmd
              ON cmd.stock_id = factor_stock.symbol
             AND cmd.date = date(sp.date)
             AND cmd.source = 'finlab.price'
           WHERE sp.date >= ?
             AND sp.date <= ?
        ), price_horizons AS (
          SELECT stock_id,
                 price_date,
                 LEAD(open, 1) OVER (PARTITION BY stock_id ORDER BY price_date) AS entry_open,
                 LEAD(adjustment_factor, 1) OVER (PARTITION BY stock_id ORDER BY price_date) AS entry_factor,
                 LEAD(close, 5) OVER (PARTITION BY stock_id ORDER BY price_date) AS exit_close,
                 LEAD(adjustment_factor, 5) OVER (PARTITION BY stock_id ORDER BY price_date) AS exit_factor
            FROM price_series
        ), replay AS (
          SELECT symbol,
                 MAX(CASE WHEN json_extract(detail_json, '$.replay_diagnostics.outcome_known_date') IS NOT NULL THEN 1 ELSE 0 END) AS v3_known,
                 MAX(CASE WHEN sample_eligible = 1 AND pnl_pct IS NOT NULL THEN 1 ELSE 0 END) AS v3_executed
            FROM s12_replay_trade_outcomes
           WHERE signal_date = ?
             AND source = 's12_multisession_structure_replay_v3'
           GROUP BY symbol
        ), structures AS (
          SELECT symbol, 1 AS structure_available
            FROM s12_structure_snapshots
           WHERE trade_date = ?
           GROUP BY symbol
        )
        SELECT ? AS signal_date,
               c.symbol,
               CASE WHEN ph.exit_close > 0 THEN 1 ELSE 0 END AS five_session_mature,
               CASE WHEN ph.entry_open > 0
                          AND ph.exit_close > 0
                          AND ph.entry_factor > 0
                          AND ph.exit_factor > 0
                    THEN 1 ELSE 0 END AS canonical_label_eligible,
               COALESCE(r.v3_known, 0) AS v3_known,
               COALESCE(r.v3_executed, 0) AS v3_executed,
               COALESCE(ss.structure_available, 0) AS structure_available
          FROM candidate c
          LEFT JOIN price_horizons ph
            ON ph.stock_id = c.stock_id
           AND ph.price_date = ?
          LEFT JOIN replay r ON r.symbol = c.symbol
          LEFT JOIN structures ss ON ss.symbol = c.symbol
         WHERE c.rn = 1
         ORDER BY c.symbol
            """,
            [
                signal_date,
                (date.fromisoformat(signal_date) + timedelta(days=1)).isoformat(),
                signal_date,
                end_date,
                signal_date,
                signal_date,
                signal_date,
                signal_date,
            ],
            timeout=120,
        ))
    return {
        (str(row.get("signal_date")), str(row.get("symbol"))): {
            key: int(row.get(key) or 0)
            for key in (
                "five_session_mature",
                "canonical_label_eligible",
                "v3_known",
                "v3_executed",
                "structure_available",
            )
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
        d1_client.query,
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
