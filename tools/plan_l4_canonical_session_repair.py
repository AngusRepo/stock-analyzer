"""Offline-only repair planner. Emits bounded SQL; it has no D1/network/apply path.

Input is a complete original FinLab raw artifact plus a read-only JSON inventory
of Core identities and saved price labels. Never rebuild features from labels.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "ml-controller"))
from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs, build_d1_upsert_statements, build_market_domain_insert_statements


def plan_repair(outputs: Any, inventory: dict[str, Any], repair_date: str) -> dict[str, Any]:
    rows = outputs.canonical_market_daily
    if not rows or any(r["date"] != repair_date for r in rows):
        raise ValueError("repair_requires_exact_nonempty_single_date")
    required = ("open", "high", "low", "close", "adj_close", "volume")
    complete = [r for r in rows if all(isinstance(r.get(k), (int, float)) and math.isfinite(r[k]) for k in required)
                and min(r["open"], r["high"], r["low"], r["close"], r["adj_close"]) > 0 and r["volume"] >= 0]
    if len(complete) < 100:
        raise ValueError("repair_full_original_ohlcv_missing_do_not_insert_calendar_only")
    # FinLab legitimately publishes volume/bid rows with no regular-session
    # OHLC (including odd-lot-only trades). Preserve that absence; never invent
    # a fill price or put these rows into compatibility return projections.
    unpriced = [r for r in rows if all(r.get(k) is None for k in required[:-1])
                and isinstance(r.get('volume'), (int, float))
                and math.isfinite(r['volume']) and r['volume'] >= 0]
    if len(complete) + len(unpriced) != len(rows):
        raise ValueError("repair_partial_original_ohlcv_would_overwrite_valid_fields")
    identities = {str(r["symbol"]): int(r["id"]) for r in inventory["stock_identities"]}
    complete_identity_inventory = (
        inventory.get('identity_inventory_scope') == 'all_core_stocks'
        and inventory.get('identity_inventory_row_count') == len(identities)
        and len(identities) == len(inventory['stock_identities'])
    )
    compatible, unmatched = [], []
    for row in complete:
        symbol = str(row["stock_id"])
        if symbol not in identities:
            unmatched.append(symbol)
            continue
        compatible.append(("""INSERT INTO stock_prices(stock_id,date,open,high,low,close,adj_close,volume)
            VALUES (?,?,?,?,?,?,?,?) ON CONFLICT(stock_id,date) DO UPDATE SET
            open=excluded.open,high=excluded.high,low=excluded.low,close=excluded.close,
            adj_close=excluded.adj_close,volume=excluded.volume""",
            [identities[symbol], repair_date, *[row[k] for k in required]]))
    if len(compatible) < 100:
        raise ValueError("repair_core_identity_coverage_incomplete")
    sessions = sorted({row["session_date"] for row in outputs.source_sessions})
    if repair_date not in sessions:
        raise ValueError("repair_date_not_in_verified_source")
    impacted = []
    verified_unchanged = []
    pending = []
    for label in inventory.get("labels", []):
        day = label["price_date"]
        later = [session for session in sessions if session > day]
        horizon = int(label.get("horizon_days") or 5)
        if len(later) < horizon:
            pending.append({"signal_date": day, "reason": "source_artifact_ends_before_horizon"})
            continue
        expected = {"entry_date": later[0], "exit_date": later[horizon - 1]}
        if any(label.get(key) != value for key, value in expected.items()):
            impacted.append({"stock_id": label["stock_id"], "signal_date": day, "horizon_days": horizon,
                             "before": {key: label.get(key) for key in expected}, "after": expected})
        else:
            verified_unchanged.append([label["stock_id"], day, horizon])
    all_statements = build_d1_upsert_statements(outputs)
    market = [s for s in all_statements if any(f"INTO {table}" in s[0] for table in (
        "canonical_market_daily", "canonical_market_index_daily", "canonical_market_summary_daily"))]
    unpriced_symbols = {r['stock_id'] for r in unpriced}
    market = [(re.sub(r'ON CONFLICT\b.*', 'ON CONFLICT DO NOTHING', sql, flags=re.S)
               if 'INTO canonical_market_daily' in sql and params[0] in unpriced_symbols else sql, params)
              for sql, params in market]
    market += build_market_domain_insert_statements(outputs) + compatible
    ops = [s for s in all_statements if "INTO finlab_materialization_" in s[0]]
    missing_context = [table for table in ("canonical_market_index_daily", "canonical_market_summary_daily")
                       if not getattr(outputs, table, [])]
    return {"schema_version": "l4-single-session-repair-plan-v1", "mode": "offline_plan_no_writes",
            "repair_date": repair_date, "source_run_id": outputs.run_id, "source_manifest": outputs.manifest,
            "canonical_rows": len(rows), "complete_ohlcv_rows": len(complete), "compatibility_rows": len(compatible),
            "source_unpriced_symbols": sorted(unpriced_symbols),
            "source_unpriced_policy": "preserve_source_nulls_insert_only_no_return_projection",
            "compatibility_scope": "core_stock_identity_join",
            "complete_core_identity_inventory": complete_identity_inventory,
            "unmatched_core_symbols": unmatched, "market_statements": market, "ops_after_market_success": ops,
            "additional_source_required": missing_context,
            "ready_for_complete_date_repair": not missing_context and (not unmatched or complete_identity_inventory),
            "labels_requiring_reprojection": impacted, "verified_unchanged_labels": len(verified_unchanged),
            "source_window_unverifiable_labels": pending,
            "label_rerun_dates": sorted({r["signal_date"] for r in impacted}),
            "frozen_oof_artifacts_modified": False, "features_or_predictions_backdated": False,
            "ipo_prospective_credit_granted": False,
            "readback": {"required": ["canonical_full_fields", "compatibility_prices", "source_session_dates", "market_index_and_summary", "market_risk_projection",
                                      "corrected_3_5_10_session_horizons", "unchanged_frozen_oof_checksums", "serving_pointer_unchanged"],
                         "status": "not_executed_requires_deployment_approval"}}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--artifact-root", required=True)
    parser.add_argument("--source-run-id", required=True)
    parser.add_argument("--repair-date", required=True)
    parser.add_argument("--inventory-json", required=True)
    args = parser.parse_args()
    outputs = materialize_finlab_canonical_outputs(args.artifact_root, run_id=args.source_run_id,
        start_date=args.repair_date, end_date=args.repair_date,
        datasets=["canonical_market_daily", "canonical_market_index_daily", "canonical_market_summary_daily"], include_emerging=False)
    # Load the artifact's full source calendar for the bounded label audit. This
    # does not make future labels available to predictions, which are untouched.
    from dataclasses import replace
    from services.finlab_canonical_materializer import build_source_sessions
    outputs = replace(outputs, source_sessions=build_source_sessions(Path(args.artifact_root), run_id=args.source_run_id,
                                                                    observed_at=outputs.generated_at, end_date=None))
    inventory_path = Path(args.inventory_json)
    inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    packet = plan_repair(outputs, inventory, args.repair_date)
    packet["inventory_sha256"] = hashlib.sha256(inventory_path.read_bytes()).hexdigest()
    print(json.dumps(packet, ensure_ascii=False, allow_nan=False, default=str))


if __name__ == "__main__":
    main()
