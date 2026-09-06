"""Fixed IPO research candidate, prospective observation only. No training/promotion API.

The four previously inspected dates are research, not prospective IPO evidence.
The comparator is the L4 output recorded on the identical frozen candidate set.
"""
from __future__ import annotations

import hashlib
import json
import math
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

import numpy as np
from scipy.stats import rankdata

from services.l4_alpha_ev_producer import _feature_value
from services.price_horizon_projection_contract import PRICE_HORIZON_PROJECTION_VERSION

SCHEMA = "ipo-prospective-shadow-v1"
EVALUATOR = "ipo-paired-frozen-5session-net18-v1"
LABEL_VERSION = PRICE_HORIZON_PROJECTION_VERSION
MODEL = {
    "schema_version": SCHEMA,
    "kind": "ipo_mvo_proxy",
    "names": ["ml_edge_norm", "fundamental_quality_norm", "chip_flow_norm", "technical_structure_norm"],
    "mean": [0.5113400959410965, 0.36953501462513405, 0.5411250304281885, 0.3423591956172529],
    "scale": [0.29352150769054663, 0.12720139683998485, 0.31185355489513106, 0.19154024146000487],
    "theta": [-0.07419486503345696, -0.036897606462376456, -0.0006582470651147064, 0.024497059138050552, -0.06619557008686246],
    "output_clip": [-0.08, 0.08],
    "risk_a": 0.011432578814240618,
    "risk_c": 0.006131728224155809,
    "cost_bps": 18,
    "training_label_known_max": "2026-08-25",
    "research_source": "2026-09-05-l4-frozen-verification/phase8/models.json",
    "research_source_sha256": "887b0ab6ad8e8a35a1a009eeb8a88a8fec1e47e9799712dd0c2f8c33c2c4b01e",
    "known_research_dates": ["2026-08-25", "2026-08-26", "2026-08-27", "2026-08-28"],
    "optimizer_stationarity_proven": False,
    "promotion_allowed": False,
    "production_allocation_allowed": False,
}


def encode(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def checksum(value: Any) -> str:
    return hashlib.sha256(encode(value).encode()).hexdigest()


CANDIDATE_ID = "ipo-shadow:" + checksum(MODEL)
Query = Callable[[str, list[Any]], list[dict[str, Any]]]
Writer = Callable[[list[tuple[str, list[Any]]]], dict[str, Any]]


def _write(writer: Writer, statements: list[tuple[str, list[Any]]]) -> None:
    result = writer(statements)
    if int(result.get("error_count") or 0) or int(result.get("success_count") or 0) != len(statements):
        raise RuntimeError("ipo_shadow_write_incomplete")


def predict(features: list[float]) -> float:
    values = np.asarray(features, dtype=float)
    if values.shape != (4,) or not np.isfinite(values).all():
        raise ValueError("ipo_shadow_feature_missing_or_nonfinite")
    x = (values - np.asarray(MODEL["mean"])) / np.asarray(MODEL["scale"])
    return float(np.clip(MODEL["theta"][0] + x @ np.asarray(MODEL["theta"][1:]), *MODEL["output_clip"]))


def freeze_daily(*, snapshot_date: str, source_run_id: str, rows: list[dict[str, Any]],
                 query: Query, writer: Writer) -> dict[str, Any]:
    now = datetime.now(timezone.utc)
    # A delayed evening run may finish after midnight, but never after the next
    # calendar-day open. Older retrospective backfills receive no forward credit.
    taipei_now = now + timedelta(hours=8)
    allowed_dates = {taipei_now.date().isoformat()}
    if taipei_now.hour < 9:
        allowed_dates.add((taipei_now.date() - timedelta(days=1)).isoformat())
    if snapshot_date not in allowed_dates or snapshot_date in MODEL["known_research_dates"]:
        return {"status": "historical_not_prospective", "promotion_allowed": False, "rows": 0}
    timestamp = now.isoformat(timespec="microseconds")
    if not rows:
        return {"status": "no_native_candidates", "promotion_allowed": False, "rows": 0}
    frozen = []
    for item in rows:
        prospective = item.get('generation_mode') == 'frozen_stacker_prospective'
        if prospective:
            from services.ipo_prospective_inputs import MODE, SEAL_SHA256, load_seal, prospective_window
            provenance = item.get('input_provenance') or {}
            if (provenance.get('mode') != MODE or provenance.get('stacker_seal_checksum') != SEAL_SHA256
                    or provenance.get('prediction_date') != snapshot_date
                    or provenance.get('production_effect') is not False
                    or provenance.get('training_dispatched') is not False
                    or snapshot_date < load_seal()['first_prospective_signal_date']
                    or not prospective_window(snapshot_date, now)):
                raise RuntimeError('ipo_shadow_prospective_provenance_invalid')
        elif item.get("generation_mode") != "native":
            raise RuntimeError("ipo_shadow_non_native_candidate")
        row, prediction = item["row"], item["prediction"]
        features = [_feature_value(name, row, prediction) for name in MODEL["names"]]
        forecast = predict(features)
        l4 = item.get("l4_payload") or {}
        l4_ev = l4.get("expected_return_mean")
        if l4_ev is not None and not math.isfinite(float(l4_ev)):
            raise ValueError("ipo_shadow_l4_comparator_nonfinite")
        frozen.append({"stock_id": int(row["stock_id"]), "symbol": str(row["symbol"]),
                       "features": features, "ipo_ev": forecast,
                       "l4_ev": float(l4_ev) if l4_ev is not None else None,
                       "l4_artifact": l4.get("artifact_id") or l4.get("model_version"),
                       "l4_payload_checksum": checksum(l4),
                       "model_set_signature": item["model_set_signature"],
                       "target_semantic_version": item["target_semantic_version"]})
        if prospective:
            frozen[-1]['input_provenance'] = item['input_provenance']
            frozen[-1]['input_mode'] = item['generation_mode']
    frozen.sort(key=lambda row: row["stock_id"])
    if len({r["stock_id"] for r in frozen}) != len(frozen):
        raise ValueError("ipo_shadow_duplicate_stock")
    data_checksum = checksum(frozen)
    old = query("SELECT * FROM ipo_shadow_batches_v1 WHERE candidate_id=? AND signal_date=?", [CANDIDATE_ID, snapshot_date])
    if old:
        if old[0]["input_checksum"] != data_checksum:
            raise RuntimeError("ipo_shadow_immutable_input_conflict")
        _verify_frozen(query, snapshot_date, frozen)
        return {"status": "already_frozen", "candidate_id": CANDIDATE_ID, "rows": len(frozen), "promotion_allowed": False}
    _write(writer, [("""INSERT OR IGNORE INTO ipo_shadow_candidates_v1
        (candidate_id, registered_at, model_json, model_checksum) VALUES (?,?,?,?)""",
        [CANDIDATE_ID, timestamp, encode(MODEL), checksum(MODEL)])])
    registered = query("SELECT * FROM ipo_shadow_candidates_v1 WHERE candidate_id=?", [CANDIDATE_ID])
    if len(registered) != 1 or registered[0]["model_checksum"] != checksum(MODEL) or registered[0]["model_json"] != encode(MODEL):
        raise RuntimeError("ipo_shadow_candidate_readback_failed")
    statements = []
    for row in frozen:
        statements.append(("""INSERT OR IGNORE INTO ipo_shadow_predictions_v1
          (candidate_id,signal_date,stock_id,symbol,frozen_at,input_json,input_checksum,ipo_ev,l4_ev,l4_artifact)
          VALUES (?,?,?,?,?,?,?,?,?,?)""", [CANDIDATE_ID, snapshot_date, row["stock_id"], row["symbol"], timestamp,
                                          encode(row), checksum(row), row["ipo_ev"], row["l4_ev"], row["l4_artifact"]]))
    _write(writer, statements)
    _verify_frozen(query, snapshot_date, frozen)
    # Publish readiness only after the exact row set is verified. Partial retries
    # may reuse rows, but never replace their predictions or frozen timestamps.
    _write(writer, [("""INSERT OR IGNORE INTO ipo_shadow_batches_v1
       (candidate_id,signal_date,source_run_id,frozen_at,row_count,input_checksum)
       VALUES (?,?,?,?,?,?)""", [CANDIDATE_ID, snapshot_date, source_run_id, timestamp, len(frozen), data_checksum])])
    batch = query("SELECT * FROM ipo_shadow_batches_v1 WHERE candidate_id=? AND signal_date=?", [CANDIDATE_ID, snapshot_date])
    if len(batch) != 1 or batch[0]["input_checksum"] != data_checksum or batch[0]["row_count"] != len(frozen):
        raise RuntimeError("ipo_shadow_batch_readback_failed")
    return {"status": "frozen", "candidate_id": CANDIDATE_ID, "rows": len(frozen), "promotion_allowed": False}


def _verify_frozen(query: Query, day: str, frozen: list[dict[str, Any]]) -> None:
    stored = query("SELECT * FROM ipo_shadow_predictions_v1 WHERE candidate_id=? AND signal_date=? ORDER BY stock_id",
                   [CANDIDATE_ID, day])
    if len(stored) != len(frozen) or any(r["input_json"] != encode(f) or r["input_checksum"] != checksum(f)
                                         for r, f in zip(stored, frozen, strict=True)):
        raise RuntimeError("ipo_shadow_prediction_readback_conflict")


def proxy_weights(scores: np.ndarray) -> np.ndarray:
    """Same long-only/cash QP as the sealed research. This is NOT sparse/OPB."""
    a, c = MODEL["risk_a"], MODEL["risk_c"]
    if not len(scores) or scores.max() <= 0:
        return np.zeros(len(scores))
    ordered = np.sort(scores)[::-1]
    k = np.arange(1, len(scores) + 1)
    cumulative = np.cumsum(ordered)
    thresholds = c * cumulative / (a + c * k)
    active = int(np.flatnonzero(ordered > thresholds)[-1])
    weights = np.maximum((scores - thresholds[active]) / a, 0)
    if weights.sum() > 1:
        thresholds = (cumulative - a) / k
        active = int(np.flatnonzero(ordered > thresholds)[-1])
        weights = np.maximum((scores - thresholds[active]) / a, 0)
    if weights.min() < 0 or weights.sum() > 1 + 1e-9:
        raise RuntimeError("ipo_shadow_proxy_allocation_invalid")
    return weights


def metrics(forecasts: list[float], outcomes: list[float]) -> dict[str, Any]:
    p, y = np.asarray(forecasts), np.asarray(outcomes)
    rank_ic = None
    if len(p) > 1 and np.std(p) > 0 and np.std(y) > 0:
        rank_ic = float(np.corrcoef(rankdata(p), rankdata(y))[0, 1])
    weights = proxy_weights(p)
    return {"rank_ic": rank_ic, "rmse": float(np.sqrt(np.mean((p - y) ** 2))),
            "proxy_net_return": float(weights @ y), "invested_fraction": float(weights.sum()),
            "max_weight": float(weights.max()) if len(weights) else 0.0}


def mature_daily(*, business_date: str, query: Query, writer: Writer, market_query: Query) -> dict[str, Any]:
    batches = query("SELECT * FROM ipo_shadow_batches_v1 WHERE signal_date < ? ORDER BY signal_date", [business_date])
    evaluated = 0
    pending = []
    for batch in batches:
        day, candidate_id = batch["signal_date"], batch["candidate_id"]
        # No using a new evaluator/model under an older identity.
        if candidate_id != CANDIDATE_ID:
            continue
        rows = query("""SELECT p.*, l.entry_date, l.exit_date, l.outcome_known_date,
                   l.entry_raw_open, l.entry_adjustment_factor, l.exit_raw_close, l.exit_adjustment_factor,
                   l.projection_version
            FROM ipo_shadow_predictions_v1 p LEFT JOIN price_horizon_labels_v1 l
              ON l.stock_id=p.stock_id AND l.price_date=p.signal_date
           WHERE p.candidate_id=? AND p.signal_date=? ORDER BY p.stock_id""", [candidate_id, day])
        if len(rows) != batch["row_count"]:
            raise RuntimeError("ipo_shadow_maturity_frozen_set_incomplete")
        if any(not r.get("exit_date") or r["exit_date"] > business_date or r.get("projection_version") != LABEL_VERSION for r in rows):
            pending.append(day)
            continue
        decoded = [json.loads(row["input_json"]) for row in rows]
        if checksum(decoded) != batch["input_checksum"]:
            raise RuntimeError("ipo_shadow_maturity_input_checksum_mismatch")
        for row, frozen in zip(rows, decoded, strict=True):
            if row["input_checksum"] != checksum(frozen) or any(row[key] != frozen[key] for key in ("stock_id", "symbol", "ipo_ev", "l4_ev", "l4_artifact")):
                raise RuntimeError("ipo_shadow_maturity_prediction_column_mismatch")
        sessions = market_query("""SELECT DISTINCT session_date FROM finlab_source_sessions_v1
            WHERE session_date>? AND session_date<=? ORDER BY session_date LIMIT 5""", [day, business_date])
        if len(sessions) < 5:
            pending.append(day)
            continue
        if any(row["entry_date"] != sessions[0]["session_date"] or row["exit_date"] != sessions[4]["session_date"] for row in rows):
            raise RuntimeError("ipo_shadow_label_horizon_session_mismatch")
        outcomes = []
        for row in rows:
            frozen_at = datetime.fromisoformat(row["frozen_at"])
            # Prices were unknown at original freeze; labels are joined only now.
            entry_open = datetime.fromisoformat(row["entry_date"] + "T09:00:00+08:00")
            if frozen_at >= entry_open or not (day < row["entry_date"] <= row["exit_date"] <= business_date):
                raise RuntimeError("ipo_shadow_maturity_time_order_violation")
            if row.get("outcome_known_date") != row["exit_date"]:
                raise RuntimeError("ipo_shadow_label_known_date_mismatch")
            entry = float(row["entry_raw_open"]) * float(row["entry_adjustment_factor"])
            exit_price = float(row["exit_raw_close"]) * float(row["exit_adjustment_factor"])
            if not math.isfinite(entry + exit_price) or min(entry, exit_price) <= 0:
                raise RuntimeError("ipo_shadow_label_price_invalid")
            outcomes.append(exit_price / entry - 1.0 - MODEL["cost_bps"] / 10000.0)
        ipo = metrics([r["ipo_ev"] for r in rows], outcomes)
        paired = all(r.get("l4_ev") is not None and r.get("l4_artifact") for r in rows)
        l4 = metrics([r["l4_ev"] for r in rows], outcomes) if paired else None
        packet = {"schema_version": SCHEMA, "evaluator_version": EVALUATOR, "signal_date": day,
                  "outcome_known_date": rows[0]["exit_date"], "sample_count": len(rows), "paired": paired,
                  "ipo": ipo, "l4": l4, "l4_artifacts": sorted({str(r["l4_artifact"]) for r in rows if r.get("l4_artifact")}),
                  "proxy_return_delta": ipo["proxy_net_return"] - l4["proxy_net_return"] if l4 else None,
                  "cost_deducted_once_bps": MODEL["cost_bps"], "exact_sparse_opb": False,
                  "promotion_allowed": False, "blockers": [] if paired else ["frozen_l4_comparator_incomplete"]}
        labels_checksum = checksum([{k: r.get(k) for k in ("stock_id", "entry_date", "exit_date", "entry_raw_open",
                                      "entry_adjustment_factor", "exit_raw_close", "exit_adjustment_factor", "projection_version")} for r in rows])
        evaluation_id = checksum([candidate_id, day, EVALUATOR, batch["input_checksum"], labels_checksum])
        _write(writer, [("""INSERT OR IGNORE INTO ipo_shadow_daily_evaluations_v1
          (evaluation_id,candidate_id,signal_date,business_date,evaluator_version,labels_checksum,metrics_json)
          VALUES (?,?,?,?,?,?,?)""", [evaluation_id, candidate_id, day, business_date, EVALUATOR, labels_checksum, encode(packet)])])
        check = query("SELECT metrics_json FROM ipo_shadow_daily_evaluations_v1 WHERE evaluation_id=?", [evaluation_id])
        if len(check) != 1 or check[0]["metrics_json"] != encode(packet):
            raise RuntimeError("ipo_shadow_evaluation_readback_failed")
        evaluated += 1
    return {"status": "evaluated" if evaluated else "pending_maturity", "evaluated_dates": evaluated,
            "pending_dates": pending, "promotion_allowed": False}
