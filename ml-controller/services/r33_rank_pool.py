"""R33 daily rank pool: seven-model z, equal-weight score and serving E-hat (R33-NEW-02).

The pool is the calibration's pool (latest screener run's final_selection that day),
so serving ranks exactly where the isotonic table was fit. Per model, raw scores are
re-ranked among the pool stocks that model scored (#78 pool_scores). A holding outside
the pool takes the position it would have if inserted, against the pool's positions,
so it never moves the pool. A row no model scored (no prediction, or stale bar) gets no
score and no E-hat: it is reported, never guessed.
"""
from __future__ import annotations

import math

import numpy as np
from scipy.stats import rankdata

from services.active8_score_semantics import MODEL_SCORE_LINEAGE_SCHEMA_VERSION, MODEL_TARGET_SEMANTIC_VERSION
from services.r33_calibration_job import POOL_SOURCE, load_l2_pool
from services.r33_crossfit_serving import serving_expected_excess
from services.r33_isotonic_calibration import MODELS, checksum, pool_scores

SNAPSHOT_SCHEMA = "r33-attested-rank-pool-v1"
EVIDENCE_SCHEMA = "r33-rank-evidence-v1"
EVIDENCE_KEY = "r33_rank_evidence"


def load_serving_pool(ops_query, *, signal_date: str, screener_run_id: str) -> tuple[list[str], dict]:
    """The calibration pool for one day; the pipeline's screener run must be that pool."""
    pool, receipt = load_l2_pool(ops_query, start=signal_date, end=signal_date)
    members = pool.get(signal_date)
    if not members:
        raise ValueError("r33_rank_pool_empty")
    rows = ops_query("SELECT symbol FROM screener_funnel_items WHERE run_id=? AND date=? AND stage='final_selection'",
                     [screener_run_id, signal_date])
    if {str(row["symbol"]) for row in rows} != members:
        raise ValueError("r33_rank_pool_screener_run_mismatch")
    return sorted(members), dict(receipt, signal_date=signal_date, screener_run_id=screener_run_id)


def _raw_scores(prediction: dict | None, *, signal_date: str, versions: dict[str, str]) -> dict[str, float]:
    """Finite raw scores from the attested lineage; a lineage that disagrees with this run fails closed."""
    lineage = (prediction or {}).get("model_score_lineage")
    if not isinstance(lineage, dict):
        return {}
    raw = lineage.get("raw_scores") or {}
    scores = {m: float(v) for m in MODELS if isinstance(v := raw.get(m), (int, float)) and math.isfinite(v)}
    if not scores:
        return {}
    if (lineage.get("schema_version") != MODEL_SCORE_LINEAGE_SCHEMA_VERSION
            or lineage.get("target_semantic_version") != MODEL_TARGET_SEMANTIC_VERSION
            or lineage.get("run_date") != signal_date or tuple(lineage.get("model_order") or ()) != MODELS):
        raise ValueError("r33_rank_pool_lineage_mismatch")
    stray = [m for m in scores if (lineage.get("artifact_versions") or {}).get(m) != versions[m]]
    if stray:
        raise ValueError("r33_rank_pool_artifact_version_mismatch:" + ",".join(stray))
    return scores


def _matrix(rows: list[dict[str, float]]) -> tuple[np.ndarray, np.ndarray]:
    raw = np.array([[r.get(m, np.nan) for m in MODELS] for r in rows], dtype=float).reshape(len(rows), len(MODELS))
    return raw, np.isfinite(raw)


def _outside_z(pool_raw, pool_available, raw, available, uninformative) -> np.ndarray:
    """Insertion position against the pool's positions; the pool's statistics are unchanged."""
    z = np.zeros(raw.shape)
    for i, model in enumerate(MODELS):
        column = pool_raw[pool_available[:, i], i]
        if model in uninformative or not len(column):
            continue
        positions = rankdata(column, method="average")
        mean, spread = positions.mean(), positions.std()
        for row in np.flatnonzero(available[:, i]):
            x = raw[row, i]
            position = 0.5 + np.sum(column < x) + 0.5 * np.sum(column == x)
            z[row, i] = (position - mean) / spread
    return z


_ROW_FIELDS = ("role", "held", "z", "available", "score", "expected_excess", "unscored_reason")


def _evidence(row: dict, *, signal_date: str, pool_checksum: str, calibration_checksum: str) -> dict:
    return dict(schema_version=EVIDENCE_SCHEMA, signal_date=signal_date, pool_checksum=pool_checksum,
                calibration_checksum=calibration_checksum, **{k: row[k] for k in _ROW_FIELDS})


def build_rank_pool(*, signal_date: str, pool: tuple[list[str], dict], predictions: dict[str, dict],
                    holdings, ensemble: dict, stale: dict[str, str] | None = None) -> dict:
    """Attach r33_rank_evidence to every pool and holding prediction; return the attested snapshot."""
    symbols, receipt = pool
    calibration = ensemble["serving_calibration"]
    source_checksum = ensemble["source_bundle"]["source_calibration_checksum"]
    variant = calibration["variant"]
    if variant != ensemble.get("variant") or receipt.get("source") != POOL_SOURCE or receipt.get("signal_date") != signal_date:
        raise ValueError("r33_rank_pool_contract_mismatch")
    versions = {m: ensemble["base_artifacts"][m]["version"] for m in MODELS}
    stale = dict(stale or {})
    in_pool = set(symbols)
    outside = sorted(set(holdings) - in_pool)
    held = set(holdings)

    def scores_of(symbol):
        return {} if symbol in stale else _raw_scores(predictions.get(symbol), signal_date=signal_date, versions=versions)

    pool_rows = {s: scores_of(s) for s in symbols}
    scored = [s for s in symbols if pool_rows[s]]
    if not scored:
        raise ValueError("r33_rank_pool_no_scored_rows")
    pool_raw, pool_available = _matrix([pool_rows[s] for s in scored])
    score, z, uninformative = pool_scores(pool_raw, pool_available, variant=variant)
    out_rows = {s: scores_of(s) for s in outside}
    out_scored = [s for s in outside if out_rows[s]]
    out_raw, out_available = _matrix([out_rows[s] for s in out_scored])
    out_z = _outside_z(pool_raw, pool_available, out_raw, out_available, uninformative)
    out_score = out_z.sum(axis=1) / len(MODELS)
    if variant == "mean_z_restandardized" and len(out_scored):
        plain = z.sum(axis=1) / len(MODELS)
        out_score = (out_score - plain.mean()) / plain.std()
    ehat = serving_expected_excess(calibration, np.r_[score, out_score], source_checksum=source_checksum)
    computed = {s: (z[i], pool_available[i], score[i], ehat[i]) for i, s in enumerate(scored)}
    computed.update({s: (out_z[i], out_available[i], out_score[i], ehat[len(scored) + i]) for i, s in enumerate(out_scored)})

    pool_checksum = checksum({"signal_date": signal_date, "screener_run_id": receipt["screener_run_id"],
                              "membership_sha256": receipt["membership_sha256"]})
    calibration_checksum = calibration["payload_checksum"]
    rows, evidence = [], {}
    for symbol in sorted(in_pool | set(outside)):
        role = "pool" if symbol in in_pool else "holding_outside_pool"
        if symbol in computed:
            zs, avail, value, expected = computed[symbol]
            row = dict(z={m: float(zs[i]) for i, m in enumerate(MODELS)},
                       available={m: bool(avail[i]) for i, m in enumerate(MODELS)},
                       score=float(value), expected_excess=float(expected), unscored_reason=None)
        else:
            reason = ("stale:" + str(stale[symbol])) if symbol in stale else (
                "prediction_missing" if symbol not in predictions else "no_model_available")
            row = dict(z={m: 0.0 for m in MODELS}, available={m: False for m in MODELS},
                       score=None, expected_excess=None, unscored_reason=reason)
        row.update(symbol=symbol, role=role, held=symbol in held)
        rows.append(row)
        evidence[symbol] = _evidence(row, signal_date=signal_date, pool_checksum=pool_checksum,
                                     calibration_checksum=calibration_checksum)
    for symbol, item in evidence.items():
        if symbol in predictions:
            predictions[symbol][EVIDENCE_KEY] = item
    snapshot = dict(
        schema_version=SNAPSHOT_SCHEMA, signal_date=signal_date, screener_run_id=receipt["screener_run_id"],
        pool_source=POOL_SOURCE, pool_membership_sha256=receipt["membership_sha256"], pool_checksum=pool_checksum,
        l3_identity={k: ensemble[k] for k in ("artifact_id", "cohort_id", "payload_checksum", "base_artifact_set_checksum")},
        model_order=list(MODELS), variant=variant, calibration_checksum=calibration_checksum,
        source_calibration_checksum=source_checksum, rows=rows, uninformative_models=list(uninformative),
        coverage=dict(pool_rows=len(symbols), pool_scored_rows=len(scored), holdings_outside_pool=len(outside),
                      by_model={m: int(pool_available[:, i].sum()) for i, m in enumerate(MODELS)},
                      unscored={r["symbol"]: r["unscored_reason"] for r in rows if r["unscored_reason"]}),
        predictions_checksum=checksum(evidence))
    snapshot["checksum"] = checksum(snapshot)
    return snapshot


def validate_rank_pool(snapshot: dict, predictions: dict[str, dict] | None = None) -> dict:
    """Checksums, and (given the predictions) that each row's prediction carries exactly its attested evidence."""
    body = {k: v for k, v in snapshot.items() if k != "checksum"}
    if snapshot.get("schema_version") != SNAPSHOT_SCHEMA or snapshot.get("checksum") != checksum(body):
        raise ValueError("r33_rank_pool_checksum_invalid")
    evidence = {row["symbol"]: _evidence(row, signal_date=snapshot["signal_date"], pool_checksum=snapshot["pool_checksum"],
                                         calibration_checksum=snapshot["calibration_checksum"])
                for row in snapshot["rows"]}
    if checksum(evidence) != snapshot.get("predictions_checksum"):
        raise ValueError("r33_rank_pool_predictions_checksum_invalid")
    if predictions is not None:
        for symbol, prediction in predictions.items():
            attached = prediction.get(EVIDENCE_KEY) if isinstance(prediction, dict) else None
            if attached is None and symbol not in evidence:
                continue
            if attached != evidence.get(symbol):
                raise ValueError("r33_rank_pool_evidence_mismatch:" + symbol)
    return snapshot
