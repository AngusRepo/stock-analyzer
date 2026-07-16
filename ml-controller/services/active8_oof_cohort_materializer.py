"""Verify and materialize immutable Active-8 OOF cohorts and EV snapshots."""

from __future__ import annotations

import hashlib
import io
import json
from collections import defaultdict
from typing import Any, Callable

import numpy as np

from services import d1_client
from services.active8_oof_stacker import (
    ACTIVE8_MODELS,
    STACKER_SEMANTIC_VERSION,
    build_chronological_oof_stack,
)
from services.ev_lineage_contract import build_model_set_signature
from services.s12_trade_ev_bootstrap import S12TradeEvBootstrapProvider
from services.model_artifact_registry import upsert_artifact_record
from services.evidence_contracts import LABEL_SCHEMA_VERSION

TARGET_SEMANTIC_VERSION = LABEL_SCHEMA_VERSION
SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    parsed = json.loads(value)
    return parsed if isinstance(parsed, dict) else {}


def _manifest_checksum(manifest: dict[str, Any]) -> str:
    unsigned = {key: value for key, value in manifest.items() if key != "manifest_checksum"}
    payload = json.dumps(unsigned, sort_keys=True, default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()


def load_verified_oof_manifest(
    manifest_path: str,
    *,
    bucket: Any,
) -> tuple[dict[str, Any], bytes]:
    raw = bucket.blob(manifest_path).download_as_bytes()
    manifest = json.loads(raw.decode("utf-8"))
    if manifest.get("schema_version") != "active8-oof-cohort-manifest-v1":
        raise ValueError("active8_oof_manifest_schema_invalid")
    if manifest.get("generation_mode") != "purged_oof":
        raise ValueError("active8_oof_manifest_generation_mode_invalid")
    if manifest.get("status") != "ready":
        raise ValueError("active8_oof_manifest_not_ready")
    if list(manifest.get("model_set") or []) != list(ACTIVE8_MODELS):
        raise ValueError("active8_oof_manifest_model_set_invalid")
    if manifest.get("manifest_checksum") != _manifest_checksum(manifest):
        raise ValueError("active8_oof_manifest_checksum_mismatch")
    return manifest, raw


def _load_prediction_artifact(
    *,
    bucket: Any,
    path: str,
    expected_checksum: str,
    expected_cohort: str,
    expected_fold: str,
    expected_model: str,
    split: dict[str, str],
) -> list[dict[str, Any]]:
    raw = bucket.blob(path).download_as_bytes()
    if hashlib.sha256(raw).hexdigest() != expected_checksum:
        raise ValueError(f"active8_oof_artifact_checksum_mismatch:{expected_model}:{expected_fold}")
    data = np.load(io.BytesIO(raw), allow_pickle=True)
    metadata = json.loads(str(data["metadata"].item()))
    expected = {
        "schema_version": "active8-oof-predictions-v1",
        "generation_mode": "purged_oof",
        "cohort_id": expected_cohort,
        "fold_id": expected_fold,
        "model_name": expected_model,
        "target_semantic_version": TARGET_SEMANTIC_VERSION,
    }
    for key, value in expected.items():
        if metadata.get(key) != value:
            raise ValueError(f"active8_oof_artifact_metadata_mismatch:{key}:{expected_model}:{expected_fold}")
    arrays = {
        name: np.asarray(data[name]).reshape(-1)
        for name in (
            "raw_scores",
            "rank_scores",
            "targets",
            "dates",
            "symbols",
            "markets",
            "label_known_dates",
        )
    }
    lengths = {len(values) for values in arrays.values()}
    if lengths != {int(metadata.get("rows") or 0)}:
        raise ValueError(f"active8_oof_artifact_array_length_mismatch:{expected_model}:{expected_fold}")
    return [
        {
            "cohort_id": expected_cohort,
            "fold_id": expected_fold,
            "prediction_date": str(arrays["dates"][idx])[:10],
            "symbol": str(arrays["symbols"][idx]),
            "market_segment": str(arrays["markets"][idx]),
            "model_name": expected_model,
            "raw_score": float(arrays["raw_scores"][idx]),
            "rank_score": float(arrays["rank_scores"][idx]),
            "target_return": float(arrays["targets"][idx]),
            "label_known_date": str(arrays["label_known_dates"][idx])[:10],
            "artifact_version": str(metadata["artifact_version"]),
            "artifact_checksum": expected_checksum,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "score_semantic_version": str(metadata["score_semantic"]),
            **split,
        }
        for idx in range(next(iter(lengths), 0))
    ]


def load_oof_prediction_rows(
    manifest: dict[str, Any],
    *,
    bucket: Any,
) -> list[dict[str, Any]]:
    cohort_id = str(manifest["cohort_id"])
    rows: list[dict[str, Any]] = []
    for window in manifest.get("windows") or []:
        fold_id = f"w{window['window_id']}"
        split = {
            "train_start": str((window.get("train_range") or [None, None])[0]),
            "train_end": str((window.get("train_range") or [None, None])[1]),
            "test_start": str((window.get("test_range") or [None, None])[0]),
            "test_end": str((window.get("test_range") or [None, None])[1]),
        }
        metrics = window.get("model_metrics") or {}
        for model_name in ACTIVE8_MODELS:
            model = metrics.get(model_name) or {}
            if model.get("status") != "ready" or not model.get("oof_artifact"):
                raise ValueError(f"active8_oof_fold_model_missing:{fold_id}:{model_name}")
            rows.extend(_load_prediction_artifact(
                bucket=bucket,
                path=str(model["oof_artifact"]),
                expected_checksum=str(model.get("artifact_checksum") or ""),
                expected_cohort=cohort_id,
                expected_fold=fold_id,
                expected_model=model_name,
                split=split,
            ))
    return rows


def _counterfactual_score_v2(native_payload: dict[str, Any], ensemble_rank: float) -> dict[str, Any]:
    if native_payload.get("version") != "score_v2":
        raise ValueError("oof_native_score_v2_missing")
    if native_payload.get("semanticVersion") != SCORE_SEMANTIC_VERSION:
        raise ValueError("oof_native_score_semantic_mismatch")
    components = dict(native_payload.get("components") or {})
    required = {"chipFlow", "technicalStructure", "fundamentalQuality"}
    if not required.issubset(components):
        raise ValueError("oof_native_non_ml_score_components_missing")
    components["mlEdge"] = round(max(0.0, min(1.0, float(ensemble_rank))) * 25.0, 6)
    components["newsTheme"] = 0.0
    total = round(sum(float(components[name]) for name in (
        "mlEdge", "chipFlow", "technicalStructure", "fundamentalQuality", "newsTheme"
    )), 6)
    return {
        **native_payload,
        "components": components,
        "total": total,
        "finalScore": total,
        "alphaAdjustment": 0.0,
        "semanticVersion": SCORE_SEMANTIC_VERSION,
        "counterfactualLineage": {
            "generationMode": "purged_oof",
            "mlEdgeOwner": STACKER_SEMANTIC_VERSION,
            "nonMlComponentsOwner": "same_day_native_score_v2_point_in_time",
            "nativeAlphaAdjustmentExcluded": True,
        },
    }


def build_oof_snapshot_rows(
    prediction_rows: list[dict[str, Any]],
    native_rows: list[dict[str, Any]],
    *,
    cohort_id: str,
    source_manifest_checksum: str,
    s12_provider_factory: Callable[[str], S12TradeEvBootstrapProvider] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    stack_rows, stack_evidence = build_chronological_oof_stack(prediction_rows)
    native_by_key = {
        (str(row.get("prediction_date") or row.get("date") or "")[:10], str(row.get("symbol") or "")): row
        for row in native_rows
    }
    versions_by_key = {
        (row["fold_id"], row["prediction_date"], row["symbol"], row["market_segment"]): row["artifact_versions"]
        for row in stack_rows
    }
    provider_factory = s12_provider_factory or (
        lambda run_date: S12TradeEvBootstrapProvider.for_run_date(run_date)
    )
    providers: dict[str, S12TradeEvBootstrapProvider] = {}
    snapshots: list[dict[str, Any]] = []
    rejected = defaultdict(int)
    for stacked in stack_rows:
        if not stacked["eligible_for_efficacy"]:
            rejected["stacker_warmup"] += 1
            continue
        native = native_by_key.get((stacked["prediction_date"], stacked["symbol"]))
        if native is None:
            rejected["native_pit_components_missing"] += 1
            continue
        try:
            score_payload = _counterfactual_score_v2(
                _loads(native.get("score_components")),
                stacked["ensemble_rank"],
            )
        except ValueError as exc:
            rejected[str(exc)] += 1
            continue
        versions = versions_by_key[(
            stacked["fold_id"], stacked["prediction_date"], stacked["symbol"], stacked["market_segment"]
        )]
        signature = build_model_set_signature(versions, list(ACTIVE8_MODELS))
        if signature is None:
            rejected["model_set_signature_invalid"] += 1
            continue
        forecast = _loads(native.get("forecast_data"))
        forecast["ensemble_v2"] = {
            "avg_rank": stacked["ensemble_rank"],
            "semantic_version": STACKER_SEMANTIC_VERSION,
            "generation_mode": "purged_oof",
            "artifact_versions": versions,
            "contributing_models": list(ACTIVE8_MODELS),
            "model_set_signature": signature,
            "stacker_source": stacked["stacker_source"],
        }
        candidate = {
            **native,
            "symbol": stacked["symbol"],
            "market_segment": stacked["market_segment"],
            "prediction_date": stacked["prediction_date"],
            "score_components": score_payload,
            "forecast_data": forecast,
        }
        if stacked["prediction_date"] not in providers:
            providers[stacked["prediction_date"]] = provider_factory(stacked["prediction_date"])
        provider = providers[stacked["prediction_date"]]
        s12_payload = provider.build_for_row(candidate, prediction=forecast)
        forecast["s12_trade_ev"] = s12_payload
        allocation = _loads(native.get("alpha_allocation"))
        allocation["s12_trade_ev"] = s12_payload
        snapshots.append({
            "cohort_id": cohort_id,
            "fold_id": stacked["fold_id"],
            "snapshot_date": stacked["prediction_date"],
            "stock_id": native.get("stock_id"),
            "symbol": stacked["symbol"],
            "market_segment": stacked["market_segment"],
            "forecast_data": json.dumps(forecast, sort_keys=True),
            "score": score_payload["finalScore"],
            "score_components": json.dumps(score_payload, sort_keys=True),
            "alpha_context": native.get("alpha_context") or "{}",
            "alpha_allocation": json.dumps(allocation, sort_keys=True),
            "market_heat_expected_return": native.get("market_heat_expected_return"),
            "recommendation_lane": native.get("recommendation_lane"),
            "l4_model_version": None,
            "s12_source": s12_payload.get("trade_expected_return_source") or s12_payload.get("source"),
            "s12_asof_date": stacked["prediction_date"],
            "label_known_date": stacked["label_known_date"],
            "model_set_signature": signature,
            "target_semantic_version": TARGET_SEMANTIC_VERSION,
            "generation_mode": "purged_oof",
            "source_manifest_checksum": source_manifest_checksum,
            "l4_executable_return_pct": stacked["target_return"],
            "label_adjustment_source": "canonical_market_daily:finlab.price",
            "prediction_generated_at": f"{stacked['prediction_date']}T13:30:00+08:00",
        })
    return snapshots, {
        "stacker": stack_evidence,
        "snapshot_rows": len(snapshots),
        "snapshot_dates": len({row["snapshot_date"] for row in snapshots}),
        "rejected": dict(sorted(rejected.items())),
    }


def load_native_pit_component_rows(
    prediction_rows: list[dict[str, Any]],
    *,
    query_fn: Callable[..., list[dict[str, Any]]] = d1_client.query,
) -> list[dict[str, Any]]:
    """Load same-day non-ML ScoreV2/S12 inputs without reconstructing future data."""

    dates = sorted({row["prediction_date"] for row in prediction_rows})
    rows: list[dict[str, Any]] = []
    for offset in range(0, len(dates), 20):
        chunk = dates[offset:offset + 20]
        placeholders = ",".join("?" for _ in chunk)
        rows.extend(query_fn(
            f"""
            SELECT
              dr.stock_id,
              s.symbol,
              dr.date prediction_date,
              dr.score,
              dr.score_components,
              dr.alpha_context,
              dr.alpha_allocation,
              dr.market_segment,
              dr.recommendation_lane,
              p.forecast_data,
              json_extract(dr.alpha_context, '$.market_heat_expected_return') market_heat_expected_return
            FROM daily_recommendations dr
            JOIN stocks s ON s.id = dr.stock_id
            LEFT JOIN predictions p
              ON p.stock_id = dr.stock_id
             AND p.prediction_date = dr.date
             AND p.model_name = 'ensemble'
             AND p.generated_at = (
               SELECT MAX(p2.generated_at)
               FROM predictions p2
               WHERE p2.stock_id = dr.stock_id
                 AND p2.prediction_date = dr.date
                 AND p2.model_name = 'ensemble'
             )
            WHERE dr.date IN ({placeholders})
              AND json_extract(dr.score_components, '$.version') = 'score_v2'
              AND json_extract(dr.score_components, '$.semanticVersion') = ?
            """,
            [*chunk, SCORE_SEMANTIC_VERSION],
        ))
    return rows


def persist_l4_oof_predictions(
    predictions: list[dict[str, Any]],
    *,
    dry_run: bool = True,
    batch_fn: Callable[..., dict[str, Any]] = d1_client.batch_execute,
) -> dict[str, Any]:
    if dry_run:
        return {"status": "dry_run", "rows": len(predictions)}
    sql = """
        INSERT INTO l4_oof_predictions (
          cohort_id, fold_id, prediction_date, symbol, market_segment,
          expected_return, prediction_json, trained_until, model_version,
          eligible_for_efficacy
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    result = batch_fn([(sql, [
        row["cohort_id"], row["fold_id"], row["prediction_date"], row["symbol"],
        row["market_segment"], row["expected_return"], row["prediction_json"],
        row["trained_until"], row["model_version"], row["eligible_for_efficacy"],
    ]) for row in predictions], timeout=60.0, chunk_size=200)
    if result.get("error_count"):
        raise RuntimeError(f"l4_oof_prediction_materialization_failed:{result}")
    return {"status": "ready", "rows": len(predictions), "result": result}


def build_fusion_oof_rows(
    snapshot_rows: list[dict[str, Any]],
    l4_predictions: list[dict[str, Any]],
    *,
    knowledge_cutoff_date: str,
    query_fn: Callable[..., list[dict[str, Any]]] = d1_client.query,
) -> list[dict[str, Any]]:
    """Attach cross-fitted L4 and mature S12 replay labels without D1 round-trip."""

    l4_by_key = {
        (row["cohort_id"], row["fold_id"], row["prediction_date"], row["symbol"], row["market_segment"]): row
        for row in l4_predictions
        if int(row.get("eligible_for_efficacy") or 0) == 1
    }
    dates = sorted({row["snapshot_date"] for row in snapshot_rows})
    replay_by_key: dict[tuple[str, str], dict[str, Any]] = {}
    for offset in range(0, len(dates), 20):
        chunk = dates[offset:offset + 20]
        placeholders = ",".join("?" for _ in chunk)
        replay_rows = query_fn(
            f"""
            SELECT symbol, date(signal_date) signal_date, pnl_pct,
                   json_extract(detail_json, '$.status') replay_status,
                   json_extract(detail_json, '$.status_reason') replay_archetype,
                   sample_eligible, created_at, id
            FROM s12_replay_trade_outcomes
            WHERE source = 's12_multisession_structure_replay_v3'
              AND date(signal_date) IN ({placeholders})
              AND date(json_extract(detail_json, '$.replay_diagnostics.outcome_known_date')) <= date(?)
            ORDER BY signal_date, symbol, sample_eligible DESC, created_at DESC, id DESC
            """,
            [*chunk, knowledge_cutoff_date],
        )
        for replay in replay_rows:
            key = (str(replay.get("signal_date") or "")[:10], str(replay.get("symbol") or ""))
            replay_by_key.setdefault(key, replay)

    rows: list[dict[str, Any]] = []
    for snapshot in snapshot_rows:
        key = (
            snapshot["cohort_id"], snapshot["fold_id"], snapshot["snapshot_date"],
            snapshot["symbol"], snapshot["market_segment"],
        )
        l4 = l4_by_key.get(key)
        if l4 is None:
            continue
        replay = replay_by_key.get((snapshot["snapshot_date"], snapshot["symbol"])) or {}
        rows.append({
            **snapshot,
            "prediction_date": snapshot["snapshot_date"],
            "l4_alpha_ev": _loads(l4["prediction_json"]),
            "allocator_ev_feature_snapshot_source": "allocator_ev_oof_snapshots",
            "allocator_ev_feature_snapshot_guard": "purged_oof_label_known_date_strict",
            "s12_replay_pnl_pct": (
                replay.get("pnl_pct") if int(replay.get("sample_eligible") or 0) == 1 else None
            ),
            "s12_replay_status": replay.get("replay_status"),
            "s12_replay_archetype": replay.get("replay_archetype"),
            "trade_pnl_pct": None,
        })
    return rows


def archive_ev_candidate_artifacts(
    *,
    bucket: Any,
    cohort_id: str,
    source_run_date: str,
    manifest_path: str,
    l4_result: dict[str, Any],
    fusion_result: dict[str, Any],
    parity: dict[str, Any] | None,
    promoted: bool,
) -> dict[str, Any]:
    """Persist complete candidate JSON and its automatic promotion evidence."""

    output = {}
    for model_name, result in (("l4_alpha_ev", l4_result), ("allocator_ev_fusion", fusion_result)):
        artifact = dict(result.get("artifact") or {})
        validation = dict(result.get("validation_packet") or {})
        model_version = str(artifact.get("model_version") or "unknown")
        payload = {
            "schema_version": "ev-oof-candidate-packet-v1",
            "cohort_id": cohort_id,
            "artifact": artifact,
            "validation_packet": validation,
            "operational_parity": parity,
            "promoted": promoted,
        }
        encoded = json.dumps(payload, sort_keys=True, ensure_ascii=False).encode("utf-8")
        checksum = hashlib.sha256(encoded).hexdigest()
        path = f"universal/ev_candidates/{cohort_id}/{model_name}/{checksum}.json"
        bucket.blob(path).upload_from_string(encoded, content_type="application/json")
        decision = str(validation.get("decision") or "PENDING").upper()
        state = "production" if promoted else "offline_passed" if decision == "PASS" else "offline_failed"
        upsert_artifact_record({
            "artifact_id": f"{model_name}:{model_version}",
            "model_name": model_name,
            "version": model_version,
            "candidate_type": "model_family_shadow",
            "state": state,
            "artifact_path": path,
            "metadata_path": path,
            "training_run_id": f"active8_oof:{cohort_id}",
            "training_manifest_path": manifest_path,
            "trained_from_snapshot": "allocator_ev_oof_snapshots",
            "feature_policy_version": artifact.get("feature_snapshot_version"),
            "checksum": checksum,
            "source_run_date": source_run_date,
            "offline_gate_status": "passed" if decision == "PASS" else "failed",
            "offline_gate_decision": decision,
            "offline_gate_failed_gates": json.dumps(validation.get("failed_gates") or []),
            "offline_evidence_json": json.dumps({
                "cohort_id": cohort_id,
                "validation_packet": validation,
                "training_data": artifact.get("training_data"),
            }, ensure_ascii=False),
            "live_gate_status": "promoted" if promoted else "parity_passed" if parity and parity.get("decision") == "PASS" else "not_started",
            "live_evidence_json": json.dumps(parity or {}, ensure_ascii=False),
            "promotion_decision": "primary" if promoted else "shadow",
            "approval_state": artifact.get("promotion_state") or "approval_required",
        })
        output[model_name] = {"path": path, "checksum": checksum, "state": state}
    return output


def persist_oof_cohort(
    *,
    manifest: dict[str, Any],
    prediction_rows: list[dict[str, Any]],
    snapshot_rows: list[dict[str, Any]],
    l4_predictions: list[dict[str, Any]] | None = None,
    dry_run: bool = True,
    query_fn: Callable[..., list[dict[str, Any]]] = d1_client.query,
    batch_fn: Callable[..., dict[str, Any]] = d1_client.batch_execute,
) -> dict[str, Any]:
    cohort_id = str(manifest["cohort_id"])
    if dry_run:
        return {
            "status": "dry_run",
            "cohort_id": cohort_id,
            "prediction_rows": len(prediction_rows),
            "snapshot_rows": len(snapshot_rows),
            "l4_prediction_rows": len(l4_predictions or []),
        }
    existing = query_fn(
        "SELECT status, artifact_manifest_checksum FROM active8_oof_cohorts WHERE cohort_id = ?",
        [cohort_id],
    )
    if existing:
        row = existing[0]
        if row.get("status") == "ready" and row.get("artifact_manifest_checksum") == manifest["manifest_checksum"]:
            return {"status": "idempotent_ready", "cohort_id": cohort_id}
        raise ValueError("active8_oof_cohort_id_collision")

    model_signature = build_model_set_signature(
        {name: f"cohort:{cohort_id}" for name in ACTIVE8_MODELS},
        list(ACTIVE8_MODELS),
    )
    d1_client.execute(
        """
        INSERT INTO active8_oof_cohorts (
          cohort_id, generation_mode, status, target_semantic_version,
          score_semantic_version, model_set_signature, expected_models,
          expected_folds, artifact_manifest_path, artifact_manifest_checksum
        ) VALUES (?, 'purged_oof', 'building', ?, ?, ?, 8, ?, ?, ?)
        """,
        [
            cohort_id,
            TARGET_SEMANTIC_VERSION,
            "same-market-same-date-percentile-rank-v1",
            model_signature,
            len(manifest.get("windows") or []),
            f"walk_forward/oof_cohorts/{cohort_id}/manifest.json",
            manifest["manifest_checksum"],
        ],
    )
    prediction_sql = """
        INSERT INTO active8_oof_predictions (
          cohort_id, fold_id, prediction_date, stock_id, symbol, market_segment,
          model_name, raw_score, rank_score, target_return, label_known_date,
          artifact_version, artifact_checksum, train_start, train_end, test_start,
          test_end, target_semantic_version, score_semantic_version
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """
    statements = [(prediction_sql, [
        row["cohort_id"], row["fold_id"], row["prediction_date"], row.get("stock_id"),
        row["symbol"], row["market_segment"], row["model_name"], row["raw_score"],
        row["rank_score"], row["target_return"], row["label_known_date"],
        row["artifact_version"], row["artifact_checksum"], row["train_start"],
        row["train_end"], row["test_start"], row["test_end"],
        row["target_semantic_version"], row["score_semantic_version"],
    ]) for row in prediction_rows]
    prediction_result = batch_fn(statements, timeout=60.0, chunk_size=200)
    if prediction_result.get("error_count"):
        raise RuntimeError(f"active8_oof_prediction_materialization_failed:{prediction_result}")

    snapshot_sql = """
        INSERT INTO allocator_ev_oof_snapshots (
          cohort_id, fold_id, snapshot_date, stock_id, symbol, market_segment,
          forecast_data, score, score_components, alpha_context, alpha_allocation,
          market_heat_expected_return, recommendation_lane, l4_model_version,
          s12_source, s12_asof_date, label_known_date, model_set_signature,
          target_semantic_version, generation_mode, source_manifest_checksum
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'purged_oof', ?)
    """
    snapshot_statements = [(snapshot_sql, [
        row["cohort_id"], row["fold_id"], row["snapshot_date"], row.get("stock_id"),
        row["symbol"], row["market_segment"], row["forecast_data"], row.get("score"),
        row.get("score_components"), row.get("alpha_context"), row["alpha_allocation"],
        row.get("market_heat_expected_return"), row.get("recommendation_lane"),
        row.get("l4_model_version"), row.get("s12_source"), row["s12_asof_date"],
        row["label_known_date"], row["model_set_signature"], row["target_semantic_version"],
        row["source_manifest_checksum"],
    ]) for row in snapshot_rows]
    snapshot_result = batch_fn(snapshot_statements, timeout=60.0, chunk_size=200)
    if snapshot_result.get("error_count"):
        raise RuntimeError(f"allocator_ev_oof_snapshot_materialization_failed:{snapshot_result}")
    l4_result = persist_l4_oof_predictions(
        list(l4_predictions or []),
        dry_run=False,
        batch_fn=batch_fn,
    )
    counts = query_fn(
        """
        SELECT
          (SELECT COUNT(*) FROM active8_oof_predictions WHERE cohort_id = ?) prediction_rows,
          (SELECT COUNT(*) FROM allocator_ev_oof_snapshots WHERE cohort_id = ?) snapshot_rows,
          (SELECT COUNT(*) FROM l4_oof_predictions WHERE cohort_id = ?) l4_prediction_rows,
          (SELECT COUNT(DISTINCT prediction_date) FROM active8_oof_predictions WHERE cohort_id = ?) prediction_dates
        """,
        [cohort_id, cohort_id, cohort_id, cohort_id],
    )[0]
    if (
        int(counts.get("prediction_rows") or 0) != len(prediction_rows)
        or int(counts.get("snapshot_rows") or 0) != len(snapshot_rows)
        or int(counts.get("l4_prediction_rows") or 0) != len(l4_predictions or [])
    ):
        raise RuntimeError("active8_oof_materialization_count_mismatch")
    d1_client.execute(
        """
        UPDATE active8_oof_cohorts
        SET status = 'ready', completed_folds = expected_folds,
            prediction_rows = ?, prediction_dates = ?, ready_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE cohort_id = ? AND status = 'building'
        """,
        [len(prediction_rows), int(counts.get("prediction_dates") or 0), cohort_id],
    )
    return {
        "status": "ready",
        "cohort_id": cohort_id,
        "prediction_result": prediction_result,
        "snapshot_result": snapshot_result,
        "l4_result": l4_result,
        "counts": counts,
    }
