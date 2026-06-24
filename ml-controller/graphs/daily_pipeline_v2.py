"""
daily_pipeline_v2.py ??Real LangGraph StateGraph for daily prediction pipeline
2026-04-07 LangGraph A+B refactor

Replaces graphs/daily_pipeline.py which was a "fake LangGraph" ??fire-and-forget
HTTP shell where state held only step_status, not domain data.

Real LangGraph this time:
  - State is typed schema with full domain data (active_stocks, payloads, predictions, etc.)
  - Nodes are pure functions reading & writing state
  - All D1/ML calls done by ml-controller directly (no fire-and-forget to worker)
  - Checkpointer disabled until a durable async backend is selected
  - Linear edges screener_load ??market_env ??payloads ??ml_predict ??recommend ??llm_reasons ??write_d1
"""
from __future__ import annotations
import asyncio
import json
import logging
import math
import operator
import os
import time
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, TypedDict

from langgraph.graph import StateGraph, END
from langgraph.types import RetryPolicy

from services import d1_client, kv_client
from services.ensemble_v2 import attach_ensemble_v2
from services.expected_return_calibration import load_expected_return_calibration_report
from services.payload_builder import (
    DAILY_RECOMMENDATION_PIPELINE_COLUMNS,
    PredictPayload,
    load_market_env,
    build_payloads,
    build_ml_universe,
)
from services.active9_dataset_policy import (
    ACTIVE_ALPHA_MODELS,
    RETIRED_ALPHA_MODELS,
    daily_sequence_target_points,
)
from services.modal_client import batch_predict
from services.model_lifecycle_policy import (
    DEFAULT_DEGRADED_DAMPENING,
    resolve_degraded_dampening,
)
from services.model_score_quality import drop_degenerate_rank_scores
from services.market_regime_state import (
    build_market_regime_contract_from_market_env,
    resolve_market_regime_contract,
)
from services.prediction_dispersion import build_prediction_dispersion_report
from services.screener_sizing_policy import resolve_controller_screener_sizing
from services.state_space_series import (
    build_state_space_series_from_payloads,
    enrich_state_space_series_with_long_history,
)
from services.timesfm_l175_sidecar import build_timesfm_l175_sidecar
from services.recommendation_service import (
    apply_core_family_evidence,
    apply_core_ml_evidence,
    build_return_history_from_payloads,
    filter_and_score_recommendations,
    apply_sparse_tangent_allocation,
    load_fundamental_quality_by_symbol,
    write_predictions_to_d1,
    write_layer2_core_gate_audit,
    write_layer3_formal_gate_audit,
    prune_predictions_outside_universe,
    update_recommendations_in_d1,
    delete_filtered_recommendations,
    re_rank_recommendations,
    merge_breeze2_reason_shadow_into_score_components,
    merge_llm_reasons_into_recommendations,
)
from services.llm_reason import build_canonical_candidate_payloads, generate_recommendation_reasons_from_payloads
from services.breeze2_reason_shadow import (
    breeze2_reason_shadow_metrics,
    build_breeze2_generation_shadow_for_canonical_payloads,
    build_breeze2_reason_shadow_for_canonical_payloads,
)
from services.sector_flow_service import run_sector_flow_pipeline
from services.persona_service import (
    ChipBar,
    MarginBar,
    PersonaOpinions,
    compute_trust_opinion,
    compute_retail_opinion,
    write_opinions as write_persona_opinions,
)

logger = logging.getLogger(__name__)

DEFAULT_TIMESFM_SEQUENCE_CONTRACT_POINTS = daily_sequence_target_points()
ACTIVE_ALPHA_MODEL_SET = set(ACTIVE_ALPHA_MODELS)
RETIRED_ALPHA_MODEL_SET = set(RETIRED_ALPHA_MODELS)
MODEL_POOL_ALLOWED_STATUSES = {"active", "degraded", "challenger", "retired"}
MODEL_POOL_SERVING_STATUSES = {"active", "degraded"}

D1_RETRY_DELAYS_SECONDS = (3.0, 8.0, 15.0)
D1_RETRYABLE_MARKERS = (
    "HTTP 429",
    "D1 DB is overloaded",
    "Requests queued for too long",
    "Too Many Requests",
)
D1_IN_CLAUSE_CHUNK_SIZE = 80


def _d1_bind_chunks(values: list[Any], size: int = D1_IN_CLAUSE_CHUNK_SIZE) -> list[list[Any]]:
    clean = [value for value in values if value is not None and value != ""]
    return [clean[i : i + size] for i in range(0, len(clean), size)]


def _require_model_pool_status(entry: dict[str, Any], model_name: str, stage: str) -> str:
    status = str((entry or {}).get("status") or "").strip()
    if status not in MODEL_POOL_ALLOWED_STATUSES:
        raise RuntimeError(f"model_pool_contract:{stage}:invalid lifecycle status for {model_name}: {status or '<missing>'}")
    return status


def _require_serving_model_version(entry: dict[str, Any], model_name: str, stage: str) -> str:
    version = str((entry or {}).get("version") or "").strip()
    if not version:
        raise RuntimeError(f"model_pool_contract:{stage}:serving model {model_name} missing version")
    return version


def _require_loaded_model_status(model_status: dict[str, str], model_name: str, stage: str) -> str:
    status = str((model_status or {}).get(model_name) or "").strip()
    if status not in MODEL_POOL_ALLOWED_STATUSES:
        raise RuntimeError(f"model_pool_contract:{stage}:missing/invalid loaded status for {model_name}: {status or '<missing>'}")
    return status


def _is_loaded_serving_model(model_status: dict[str, str], model_name: str, stage: str) -> bool:
    return _require_loaded_model_status(model_status, model_name, stage) in MODEL_POOL_SERVING_STATUSES


def _is_optional_loaded_serving_model(model_status: dict[str, str], model_name: str, stage: str) -> bool:
    status = str((model_status or {}).get(model_name) or "retired").strip()
    if status not in MODEL_POOL_ALLOWED_STATUSES:
        raise RuntimeError(f"model_pool_contract:{stage}:invalid optional loaded status for {model_name}: {status}")
    return status in MODEL_POOL_SERVING_STATUSES


def _require_loaded_serving_version(active_versions: dict[str, str], model_name: str, stage: str) -> str:
    version = str((active_versions or {}).get(model_name) or "").strip()
    if not version:
        raise RuntimeError(f"model_pool_contract:{stage}:serving model {model_name} missing loaded version")
    return version


def _daily_recommendation_select(alias: str = "dr") -> str:
    return ", ".join(
        f"{alias}.{column.strip()}"
        for column in DAILY_RECOMMENDATION_PIPELINE_COLUMNS.split(",")
    )


def _is_retryable_d1_overload(error: Exception) -> bool:
    message = str(error)
    return any(marker.lower() in message.lower() for marker in D1_RETRYABLE_MARKERS)


async def _load_market_env_with_backoff(run_date: str):
    """Retry the hot-path market environment read when D1 is temporarily saturated."""
    for attempt in range(len(D1_RETRY_DELAYS_SECONDS) + 1):
        try:
            return await asyncio.to_thread(load_market_env, run_date)
        except Exception as exc:  # noqa: BLE001
            if attempt >= len(D1_RETRY_DELAYS_SECONDS) or not _is_retryable_d1_overload(exc):
                raise
            delay = D1_RETRY_DELAYS_SECONDS[attempt]
            logger.warning(
                "[Pipeline V2] load_market_env D1 overload attempt=%s/%s; retry in %.1fs: %s",
                attempt + 1,
                len(D1_RETRY_DELAYS_SECONDS) + 1,
                delay,
                exc,
            )
            await asyncio.sleep(delay)


def _state_space_overlay_mode() -> str:
    raw = (
        os.environ.get("PIPELINE_STATE_SPACE_OVERLAY_MODE")
        or os.environ.get("STATE_SPACE_OVERLAY_MODE")
        or "blocking"
    )
    mode = str(raw).strip().lower()
    return mode if mode in {"blocking", "shadow", "disabled"} else "blocking"


def _state_space_overlay_soft_deadline_seconds() -> float | None:
    raw = (
        os.environ.get("PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS")
        or os.environ.get("STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS")
    )
    if raw is None or not str(raw).strip():
        return None
    try:
        value = float(str(raw).strip())
    except ValueError:
        return None
    return value if value > 0 else None


def _state_space_shadow_callback_config() -> tuple[str | None, str | None]:
    worker_url = os.environ.get("STOCKVISION_WORKER_URL", "").strip().rstrip("/")
    token = os.environ.get("STOCKVISION_AUTH_TOKEN", "").strip()
    if not worker_url or not token:
        return None, None
    return f"{worker_url}/api/internal/state-space-shadow/callback", token


def _state_space_overlay_block_reason(row: dict[str, Any]) -> str | None:
    """Return why a state-space overlay row must stay out of prediction payloads."""
    if row.get("error"):
        return str(row.get("error") or "state_space_overlay_error")
    fallback_reason = row.get("fallback_reason")
    if row.get("degraded") or fallback_reason:
        return str(fallback_reason or "degraded_state_space_overlay")
    return None


def _require_trading_config_contract(cfg_result: Any, stage: str) -> None:
    contract = getattr(cfg_result, "contract", None)
    if not getattr(contract, "degraded", False):
        return
    detail = contract.to_dict() if hasattr(contract, "to_dict") else {"degraded": True}
    raise RuntimeError(f"trading_config_contract_degraded:{stage}:{detail}")


def _modal_batch_result_summary(raw: Any) -> dict:
    if isinstance(raw, BaseException):
        return {
            "status": "exception",
            "n_input": None,
            "n_success": 0,
            "n_error": None,
            "error_summary": {
                "top_errors": [{"error": f"{type(raw).__name__}: {raw}", "count": 1}],
            },
        }
    if not isinstance(raw, dict):
        return {"status": "invalid_payload", "n_input": None, "n_success": 0, "n_error": None}
    summary = {
        "status": "ok" if not raw.get("error") else "error",
        "n_input": raw.get("n_input"),
        "n_success": raw.get("n_success"),
        "n_error": raw.get("n_error"),
        "error": raw.get("error"),
    }
    if isinstance(raw.get("error_summary"), dict):
        summary["error_summary"] = raw["error_summary"]
        return summary
    counts: dict[str, int] = {}
    for row in raw.get("results") or []:
        if isinstance(row, dict) and row.get("error"):
            message = str(row.get("error") or "unknown error")
            counts[message] = counts.get(message, 0) + 1
    if counts:
        ranked = sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))
        summary["error_summary"] = {
            "error_count": sum(counts.values()),
            "unique_error_count": len(counts),
            "top_errors": [
                {"error": message, "count": count}
                for message, count in ranked[:5]
            ],
        }
    return summary


def _sequence_contract_subset(
    series: list[dict],
    *,
    min_points: int,
) -> tuple[list[dict], list[dict[str, Any]]]:
    usable: list[dict] = []
    excluded: list[dict[str, Any]] = []
    for row in series or []:
        prices = row.get("prices") if isinstance(row, dict) else None
        point_count = len(prices) if isinstance(prices, list) else 0
        if point_count >= max(1, int(min_points)):
            usable.append(row)
            continue
        symbol = str(row.get("symbol") or row.get("stock_id") or "") if isinstance(row, dict) else ""
        excluded.append({
            "symbol": symbol,
            "points": point_count,
            "reason": "insufficient_sequence_points",
        })
    return usable, excluded


def _sequence_coverage(series: list[dict], *, min_points: int = 50) -> dict[str, Any]:
    total = len(series or [])
    usable, _excluded = _sequence_contract_subset(series, min_points=min_points)
    usable_count = len(usable)
    ratio = usable_count / total if total else 0.0
    return {"total": total, "usable": usable_count, "ratio": round(ratio, 6), "min_points": min_points}


def _timesfm_artifact_sequence_contract_points(pool: dict | None) -> int | None:
    entry = ((pool or {}).get("models") or {}).get("TimesFM") or {}
    gcs_path = str(entry.get("gcs_path") or "").strip()
    version = str(entry.get("version") or "").strip()
    if not gcs_path and version:
        gcs_path = f"universal/timesfm/{version}.json"
    if not gcs_path:
        raise RuntimeError("TimesFM active model missing gcs_path/version for sequence contract")
    try:
        from google.cloud import storage

        bucket_name = os.environ.get("GCS_BUCKET_NAME", "").strip()
        if not bucket_name:
            raise RuntimeError("GCS_BUCKET_NAME not set for TimesFM sequence contract")
        blob = storage.Client().bucket(bucket_name).blob(gcs_path)
        if not blob.exists():
            raise RuntimeError(f"TimesFM sequence contract artifact missing: {gcs_path}")
        config = json.loads(blob.download_as_text().lstrip("\ufeff"))
        seq_len = int(config.get("seq_len") or 0)
        if seq_len <= 0:
            raise RuntimeError(f"TimesFM sequence contract artifact has invalid seq_len: {gcs_path}")
        return seq_len
    except Exception as exc:  # noqa: BLE001
        raise RuntimeError(f"TimesFM artifact sequence contract lookup failed: {exc}") from exc


def _timesfm_sequence_contract_points(pool: dict | None = None) -> int:
    raw = os.environ.get("TIMESFM_SEQUENCE_CONTRACT_POINTS")
    if raw is None or not str(raw).strip():
        return _timesfm_artifact_sequence_contract_points(pool)
    value = int(str(raw).strip())
    if value <= 0:
        raise ValueError("TIMESFM_SEQUENCE_CONTRACT_POINTS must be positive")
    return value


def _timesfm_sync_gate(
    *,
    model_status: dict[str, str],
    pool: dict | None,
    ev2_cfg: dict | None,
    sequence_series: list[dict],
) -> tuple[bool, dict[str, Any]]:
    status = model_status.get("TimesFM", "retired")
    if status not in {"active", "degraded"}:
        return False, {"allowed": False, "reason": "timesfm_retired_by_model_pool", "status": status}

    sequence_contract_points = _timesfm_sequence_contract_points(pool)
    coverage = _sequence_coverage(sequence_series, min_points=sequence_contract_points)
    usable_series, excluded = _sequence_contract_subset(
        sequence_series,
        min_points=sequence_contract_points,
    )
    coverage["excluded_count"] = len(excluded)
    coverage["excluded_symbols"] = excluded[:20]
    if not usable_series:
        return False, {
            "allowed": False,
            "reason": "timesfm_sequence_contract_unmet",
            "status": status,
            "coverage": coverage,
            "sequence_contract_points": sequence_contract_points,
        }

    serving_ic = _build_serving_ic_bundle(pool, "GLOBAL", ev2_cfg or {})
    weight = float((serving_ic.get("weights") or {}).get("TimesFM") or 0.0)
    diagnostic = (serving_ic.get("diagnostics") or {}).get("TimesFM") or {}
    if weight <= 0.0:
        return True, {
            "allowed": True,
            "reason": "timesfm_observation_only_non_positive_effective_ic",
            "status": status,
            "coverage": coverage,
            "effective_weight": weight,
            "diagnostic": diagnostic,
            "sequence_contract_points": sequence_contract_points,
            "sequence_contract_mode": "per_symbol_subset",
            "ensemble_contribution_allowed": False,
        }
    return True, {
        "allowed": True,
        "reason": "timesfm_sidecar_only_direct_alpha_blocked",
        "status": status,
        "coverage": coverage,
        "effective_weight": weight,
        "diagnostic": diagnostic,
        "sequence_contract_points": sequence_contract_points,
        "sequence_contract_mode": "per_symbol_subset",
        "ensemble_contribution_allowed": False,
        "direct_alpha_blocked": True,
    }


def _breeze2_reason_shadow_enabled() -> bool:
    raw = os.environ.get("BREEZE2_REASON_SHADOW", "1")
    return str(raw).strip().lower() not in {"0", "false", "off", "disabled", "no"}


def _breeze2_reason_shadow_provider() -> str:
    provider = str(os.environ.get("BREEZE2_REASON_SHADOW_PROVIDER") or "modal_generation").strip().lower()
    return provider if provider in {"context", "modal_generation"} else "context"


def _float_env(name: str, default: float, *, minimum: float, maximum: float) -> float:
    try:
        value = float(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        value = default
    return max(minimum, min(maximum, value))


def _breeze2_reason_generation_timeout_seconds() -> float:
    return _float_env("BREEZE2_REASON_GENERATION_TIMEOUT_SECONDS", 75.0, minimum=5.0, maximum=180.0)


def _l2_l3_split_enabled() -> bool:
    raw = os.environ.get("PIPELINE_L2_L3_SPLIT_ENABLED", "1")
    return str(raw).strip().lower() not in {"0", "false", "off", "disabled", "no"}


_L2_TREE_MODEL_NAMES = ("LightGBM", "XGBoost", "ExtraTrees")


def _l2_tree_gate_score(prediction: dict | None) -> tuple[float | None, list[str]]:
    if not isinstance(prediction, dict):
        return None, []
    rank_scores = prediction.get("rank_scores")
    if not isinstance(rank_scores, dict):
        return None, []
    scores: list[float] = []
    models: list[str] = []
    for name in _L2_TREE_MODEL_NAMES:
        value = rank_scores.get(name)
        try:
            score = float(value)
        except (TypeError, ValueError):
            continue
        if not math.isfinite(score):
            continue
        scores.append(max(0.0, min(1.0, score)))
        models.append(name)
    if not scores:
        return None, []
    return sum(scores) / len(scores), models


def _payloads_for_symbols(payloads: list[dict], symbols: list[str]) -> list[dict]:
    wanted = {str(symbol) for symbol in symbols}
    return [
        payload
        for payload in payloads or []
        if str(payload.get("symbol") or "") in wanted
    ]


def _attach_l2_core_ml_evidence(
    predictions: dict[str, dict],
    *,
    target_size: int,
    upstream_count: int,
) -> tuple[dict[str, dict], list[str], dict]:
    scored: list[tuple[str, float, list[str]]] = []
    for symbol, prediction in (predictions or {}).items():
        score, models = _l2_tree_gate_score(prediction)
        if score is None:
            continue
        scored.append((symbol, score, models))

    ranked = sorted(scored, key=lambda item: item[1], reverse=True)
    selected_symbols = [symbol for symbol, _score, _models in ranked[:max(0, target_size)]]
    selected_set = set(selected_symbols)
    rank_by_symbol = {symbol: idx + 1 for idx, (symbol, _score, _models) in enumerate(ranked)}
    score_by_symbol = {symbol: score for symbol, score, _models in ranked}
    models_by_symbol = {symbol: models for symbol, _score, models in ranked}

    gated: dict[str, dict] = {}
    for symbol, prediction in (predictions or {}).items():
        row = dict(prediction or {})
        rank = rank_by_symbol.get(symbol)
        score = score_by_symbol.get(symbol)
        evidence = {
            "schema_version": "core_ml_evidence_v1",
            "legacy_schema_version": "core_ml_gate_v2",
            "source": "l2_tree_evidence",
            "stage": "L2",
            "selection_role": "evidence_only_l3_formal_inference_queue",
            "final_recommendation_gate": False,
            "selected": symbol in selected_set,
            "l3_formal_inference_selected": symbol in selected_set,
            "rank": rank,
            "target_size": target_size,
            "upstream_count": upstream_count,
            "score": round(float(score), 6) if score is not None else None,
            "models": models_by_symbol.get(symbol, []),
        }
        row["core_ml_evidence"] = evidence
        row["core_ml_gate"] = evidence
        gated[symbol] = row

    summary = {
        "schema_version": "l2_core_ml_evidence_v1",
        "legacy_schema_version": "l2_core_ml_gate_v1",
        "source": "l2_tree_evidence",
        "selection_role": "evidence_only_l3_formal_inference_queue",
        "final_recommendation_gate": False,
        "target_size": target_size,
        "upstream_count": upstream_count,
        "scored_count": len(scored),
        "l3_formal_inference_count": len(selected_symbols),
        "l3_formal_inference_symbols": selected_symbols,
        "selected_count": len(selected_symbols),
        "selected_symbols": selected_symbols,
    }
    return gated, selected_symbols, summary


def _attach_l2_core_ml_gate(
    predictions: dict[str, dict],
    *,
    target_size: int,
    upstream_count: int,
) -> tuple[dict[str, dict], list[str], dict]:
    """Deprecated compatibility wrapper; L2 now emits evidence, not a gate."""
    return _attach_l2_core_ml_evidence(
        predictions,
        target_size=target_size,
        upstream_count=upstream_count,
    )


# ?????????????????????????????????????????????????????????????????????????????
# State schema ??typed, contains domain data (not just step_status)
# ?????????????????????????????????????????????????????????????????????????????

class PipelineStateV2(TypedDict, total=False):
    """
    Full pipeline state. Each node reads relevant fields and returns an update dict.
    LangGraph reducer merges updates back into state automatically.
    """
    run_date: str
    producer_run_id: str

    # Loaded inputs
    active_stocks: list[dict]              # from latest screener funnel candidate seed
    screener_recs: list[dict]              # screener-owned seed rows, enriched with optional daily_recommendations state
    screener_run_id: str                    # latest screener_funnel_runs.run_id used as candidate source
    market_env: dict                        # market_risk + twii + breadth + us + history
    adaptive_params: dict                   # from KV ml:adaptive_params
    barrier_params: dict                    # from KV trading:config.barrier
    lifecycle_weights: dict                 # from model_pool.json
    trading_config: dict                    # B12 fix: full KV trading:config (sltp/signal/circuit)

    # Computed
    payloads: list[dict]                    # PredictPayload as dict
    timesfm_l175_sidecars: dict              # symbol -> TimesFM L1.75 sidecar payload
    timesfm_l175_summary: dict               # L1.75 feature enrichment telemetry
    predictions: dict                       # symbol ??ml result
    l2_predictions: dict                     # symbol -> cheap tree-only L2 result
    l2_selected_symbols: list[str]           # symbols admitted to L3 formal inference queue
    l2_core_ml_evidence_summary: dict        # L2 coarse evidence audit summary
    l2_core_ml_gate_summary: dict            # Legacy alias for L2 coarse evidence summary
    l3_payloads: list[dict]                  # reduced payloads sent to L3 formal ML
    l3_predictions: dict                     # symbol -> formal L3 merged result
    final_recommendations: list[dict]       # after filter + scoring + allocation
    layer2_recommendation_symbols: list[str] # symbols entering formal L3 family evidence
    layer3_formal_gate_target_size: int      # legacy audit field; now equals L3 evidence input count
    sell_filtered_symbols: list[str]        # symbols dropped due to SELL/NO_SIGNAL
    llm_reasons: dict                       # symbol ??{reason, watchPoints}

    breeze2_reason_shadow: dict             # symbol -> advisory-only Breeze2 shadow reason

    # Outputs
    sector_flow_summary: dict               # Phase 6: RRG compute result (concept + industry)
    persona_opinions: dict                  # symbol ??{trust:{...}, retail:{...}} (Taiwan-persona augmentation)
    metrics: dict                           # timing, counts
    errors: Annotated[list[str], operator.add]


# ?????????????????????????????????????????????????????????????????????????????
# Nodes
# ?????????????????????????????????????????????????????????????????????????????

async def node_load_inputs(state: PipelineStateV2) -> dict:
    """
    Load active_stocks + existing screener_recs from D1.
    """
    logger.info("[Pipeline V2] node_load_inputs")
    run_date = state["run_date"]

    screener_recs = d1_client.query(
        f"""
        WITH latest_screener_run AS (
            SELECT run_id
              FROM screener_funnel_runs
             WHERE date = ?
               AND status = 'success'
             ORDER BY created_at DESC
             LIMIT 1
        ),
        candidate_seed AS (
            SELECT
                sfi.*,
                ROW_NUMBER() OVER (
                    PARTITION BY sfi.symbol
                    ORDER BY
                        CASE sfi.stage
                            WHEN 'l1_candidate_seed_after_overlay' THEN 0
                            WHEN 'final_selection' THEN 1
                            ELSE 3
                        END,
                        COALESCE(sfi.rank, 999999)
                ) AS stage_preference_rank
              FROM screener_funnel_items sfi
             WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
               AND (
                    sfi.stage = 'l1_candidate_seed_after_overlay' AND sfi.decision = 'selected'
                 OR sfi.stage = 'final_selection' AND sfi.decision = 'selected'
               )
        ),
        scoring_seed AS (
            SELECT *
              FROM (
                SELECT
                    sfi.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY sfi.symbol
                        ORDER BY COALESCE(sfi.rank, 999999), sfi.created_at DESC
                    ) AS scoring_rank
                  FROM screener_funnel_items sfi
                 WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                   AND sfi.stage = 'scoring'
                   AND sfi.decision = 'pass'
              )
             WHERE scoring_rank = 1
        ),
        l1_seed AS (
            SELECT *
              FROM (
                SELECT
                    sfi.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY sfi.symbol
                        ORDER BY COALESCE(sfi.rank, 999999), sfi.created_at DESC
                    ) AS l1_rank
                  FROM screener_funnel_items sfi
                 WHERE sfi.run_id = (SELECT run_id FROM latest_screener_run)
                   AND sfi.stage = 'l1_candidate_seed_after_overlay'
                   AND sfi.decision = 'selected'
              )
             WHERE l1_rank = 1
        )
        SELECT
            dr.id AS id,
            sfi.run_id AS screener_run_id,
            ? AS date,
            COALESCE(dr.stock_id, st.id) AS stock_id,
            sfi.symbol AS symbol,
            COALESCE(dr.name, sfi.name, st.name, sfi.symbol) AS name,
            COALESCE(dr.sector, st.sector) AS sector,
            COALESCE(
                dr.industry,
                CASE WHEN json_valid(scoring.evidence) THEN json_extract(scoring.evidence, '$.taxonomy.industry') END,
                CASE WHEN json_valid(l1.evidence) THEN json_extract(l1.evidence, '$.industry') END,
                st.sector
            ) AS industry,
            COALESCE(sfi.rank, dr.rank, 999999) AS rank,
            COALESCE(sfi.score_after, dr.score, scoring.score_after, 0) AS score,
            dr.signal AS signal,
            dr.confidence AS confidence,
            COALESCE(
                dr.reason,
                CASE WHEN json_valid(l1.evidence) THEN json_extract(l1.evidence, '$.strategy_pool_reason') END,
                sfi.reason_code,
                'screener candidate seed'
            ) AS reason,
            COALESCE(
                dr.watch_points,
                json_array('screener_seed:' || sfi.stage, 'screener_run:' || sfi.run_id)
            ) AS watch_points,
            COALESCE(dr.has_buy_signal, 0) AS has_buy_signal,
            dr.current_price AS current_price,
            dr.foreign_net_5d AS foreign_net_5d,
            dr.trust_net_5d AS trust_net_5d,
            dr.rsi14 AS rsi14,
            dr.macd_hist AS macd_hist,
            dr.sector_rank AS sector_rank,
            COALESCE(
                dr.market_segment,
                CASE WHEN json_valid(sfi.evidence) THEN json_extract(sfi.evidence, '$.market_segment') END,
                CASE WHEN json_valid(l1.evidence) THEN json_extract(l1.evidence, '$.market_segment') END,
                st.market,
                'LISTED'
            ) AS market_segment,
            COALESCE(
                dr.recommendation_lane,
                CASE
                    WHEN upper(COALESCE(st.market, '')) IN ('TWSE', 'TSE', 'LISTED', 'OTC', 'TPEX') THEN 'tradable'
                    WHEN upper(COALESCE(st.market, '')) IN ('EMERGING', 'ESB', 'ROTC') THEN 'emerging_watchlist'
                    ELSE 'research_only'
                END
            ) AS recommendation_lane,
            COALESCE(dr.eligible_for_ml, 1) AS eligible_for_ml,
            COALESCE(
                dr.eligible_for_pending_buy,
                CASE
                    WHEN upper(COALESCE(st.market, '')) IN ('TWSE', 'TSE', 'LISTED', 'OTC', 'TPEX') THEN 1
                    ELSE 0
                END
            ) AS eligible_for_pending_buy,
            dr.alpha_context AS alpha_context,
            dr.alpha_allocation AS alpha_allocation,
            dr.ml_vote_summary AS ml_vote_summary,
            COALESCE(
                CASE WHEN json_valid(scoring.evidence) THEN json_extract(scoring.evidence, '$.score_components') END,
                dr.score_components
            ) AS score_components
          FROM candidate_seed sfi
          LEFT JOIN daily_recommendations dr
            ON dr.date = ?
           AND dr.symbol = sfi.symbol
          LEFT JOIN stocks st
            ON st.symbol = sfi.symbol
          LEFT JOIN scoring_seed scoring
            ON scoring.symbol = sfi.symbol
          LEFT JOIN l1_seed l1
            ON l1.symbol = sfi.symbol
         WHERE sfi.stage_preference_rank = 1
           AND COALESCE(dr.stock_id, st.id) IS NOT NULL
         ORDER BY COALESCE(sfi.rank, dr.rank, 999999), COALESCE(sfi.score_after, dr.score, scoring.score_after, 0) DESC
        """,
        [run_date, run_date, run_date],
    )
    if not screener_recs:
        raise RuntimeError(
            "screener_recs_missing: daily pipeline requires latest screener "
            "L1.5 router-owned l1_candidate_seed_after_overlay before ML/recommendation; "
            "refusing watchlist fallback"
        )
    active_stocks = build_ml_universe([], screener_recs)

    logger.info(
        f"[Pipeline V2] Loaded {len(active_stocks)} ML universe stocks "
        f"(source=latest_screener_candidate_seed), "
        f"{len(screener_recs)} existing screener_recs"
    )
    return {
        "active_stocks": active_stocks,
        "screener_recs": screener_recs,
        "screener_run_id": str(screener_recs[0].get("screener_run_id") or ""),
    }


async def node_load_market_env(state: PipelineStateV2) -> dict:
    """
    Load shared market data + adaptive_params + barrier_params + lifecycle_weights.
    """
    logger.info("[Pipeline V2] node_load_market_env")
    market_env, adaptive, barrier, lifecycle, trading_cfg = await _load_market_env_with_backoff(state["run_date"])
    return {
        "market_env": _to_dict(market_env),
        "adaptive_params": adaptive,
        "barrier_params": barrier,
        "lifecycle_weights": lifecycle,
        "trading_config": trading_cfg,  # B12 fix: forward to ml_predict
    }


async def node_build_payloads(state: PipelineStateV2) -> dict:
    """
    Build PredictPayload list for all active stocks (bulk D1 reads).
    """
    logger.info("[Pipeline V2] node_build_payloads")
    from services.payload_builder import MarketEnv

    # Reconstruct MarketEnv from dict
    me_dict = state["market_env"]
    market_env = MarketEnv(**{k: v for k, v in me_dict.items() if k in MarketEnv.__dataclass_fields__})

    payloads = build_payloads(
        active_stocks=state["active_stocks"],
        market_env=market_env,
        adaptive_params=state.get("adaptive_params") or {},
        barrier_params=state.get("barrier_params") or {},
        lifecycle_weights=state.get("lifecycle_weights") or {},
        trading_config=state.get("trading_config") or {},
    )
    payloads_dict = [_to_dict(p) for p in payloads]
    return {"payloads": payloads_dict}


async def node_ml_predict(state: PipelineStateV2) -> dict:
    """
    Single batch_predict call ??modal.map() (or httpx parallel concurrency=20).
    No serial sub-batching: all stocks at once, controller-side parallel.

    2026-06-04 ML_POOL new L3 family:
    - Parallel batch: tree/tabular/graph alpha predictors + DLinear/PatchTST/iTransformer/TimesFM.
    - Per-stock merged signal: time_series ??rank via sigmoid, weighted by
      ic_weights ? lifecycle_weights from model_pool.json.
    - Original signal preserved as r["signal"] for backward compat;
      merged exposed as r["ensemble_v2"] = {avg_rank, signal, contributing_models}.
    """
    import asyncio
    import json as _json
    import math
    from services import modal_client

    payloads = state["payloads"]
    n = len(payloads)
    logger.info(f"[Pipeline V2] node_ml_predict: {n} stocks (batch feature models + L3 sequence family)")

    if not payloads:
        return {"predictions": {}}

    # Build shared close-price series once for time-series predictors, then
    # enrich from the FinLab long-history sequence artifact when available.
    base_sequence_series = build_state_space_series_from_payloads(payloads)
    sequence_series, sequence_dataset_meta = enrich_state_space_series_with_long_history(
        base_sequence_series,
        target_points=daily_sequence_target_points(),
    )
    sequence_contract_points = daily_sequence_target_points()
    sequence_model_series, sequence_model_excluded = _sequence_contract_subset(
        sequence_series,
        min_points=sequence_contract_points,
    )
    sequence_dataset_meta = {
        **sequence_dataset_meta,
        "sequence_model_contract_points": sequence_contract_points,
        "sequence_model_usable": len(sequence_model_series),
        "sequence_model_excluded_count": len(sequence_model_excluded),
        "sequence_model_excluded_symbols": sequence_model_excluded[:20],
    }

    # Parallel: alpha predictors + state overlays.
    # Kalman/Markov are state overlays only; they do not enter alpha challenger.
    model_status, active_versions, _challenger_versions, pool_versions_loaded = await asyncio.to_thread(_load_model_pool_versions)
    (
        serving_model_status,
        _serving_ic_universe,
        serving_degraded_dampening,
        serving_ev2_cfg,
        serving_used_pool,
        serving_pool,
    ) = await asyncio.to_thread(_load_pool_and_ic)
    if serving_model_status:
        model_status = {**model_status, **serving_model_status}

    async def _skip_batch(reason: str) -> dict:
        return {"error": reason, "results": []}

    def _sequence_model_skip_reason(model_name: str) -> str:
        if not _is_loaded_serving_model(model_status, model_name, "ml_predict_task_plan"):
            return f"{model_name} retired by model_pool"
        return f"{model_name} sequence contract unmet"

    stage_timings: dict[str, dict[str, Any]] = {}

    async def _timed_stage(name: str, awaitable, *, required_alpha: bool) -> Any:
        started = time.time()
        status = "ok"
        error = None
        try:
            result = await awaitable
            if isinstance(result, dict) and result.get("error") and result.get("results") == []:
                status = "skipped"
            return result
        except BaseException as exc:  # noqa: BLE001
            status = "exception"
            error = f"{type(exc).__name__}: {exc}"
            raise
        finally:
            stage_timings[name] = {
                "wall_sec": round(time.time() - started, 3),
                "required_alpha": required_alpha,
                "status": status,
                "error": error,
            }

    feat_task = batch_predict(payloads)
    gnn_task = (
        modal_client.gnn_graphsage_batch_predict(
            payloads,
            version=_require_loaded_serving_version(active_versions, "GNN", "ml_predict_task_plan"),
        )
        if _is_loaded_serving_model(model_status, "GNN", "ml_predict_task_plan")
        else _skip_batch("GNN retired by model_pool")
    )
    dlinear_task = (
        modal_client.dlinear_batch_predict(
            sequence_model_series,
            horizon_used=5,
            version=_require_loaded_serving_version(active_versions, "DLinear", "ml_predict_task_plan"),
        )
        if _is_loaded_serving_model(model_status, "DLinear", "ml_predict_task_plan") and sequence_model_series
        else _skip_batch(_sequence_model_skip_reason("DLinear"))
    )
    patchtst_task = (
        modal_client.patchtst_batch_predict(
            sequence_model_series,
            horizon_used=5,
            version=_require_loaded_serving_version(active_versions, "PatchTST", "ml_predict_task_plan"),
        )
        if _is_loaded_serving_model(model_status, "PatchTST", "ml_predict_task_plan") and sequence_model_series
        else _skip_batch(_sequence_model_skip_reason("PatchTST"))
    )
    itransformer_task = (
        modal_client.itransformer_batch_predict(
            sequence_model_series,
            horizon_used=5,
            version=_require_loaded_serving_version(active_versions, "iTransformer", "ml_predict_task_plan"),
        )
        if _is_loaded_serving_model(model_status, "iTransformer", "ml_predict_task_plan") and sequence_model_series
        else _skip_batch(_sequence_model_skip_reason("iTransformer"))
    )
    timesfm_allowed, timesfm_gate = _timesfm_sync_gate(
        model_status=model_status,
        pool=serving_pool,
        ev2_cfg=serving_ev2_cfg,
        sequence_series=sequence_series,
    )
    timesfm_sequence_series, _timesfm_excluded = _sequence_contract_subset(
        sequence_series,
        min_points=int(timesfm_gate.get("sequence_contract_points") or DEFAULT_TIMESFM_SEQUENCE_CONTRACT_POINTS),
    )
    timesfm_task = (
        modal_client.timesfm_batch_predict(
            timesfm_sequence_series,
            horizon_used=5,
            version=_require_loaded_serving_version(active_versions, "TimesFM", "ml_predict_task_plan"),
            sequence_contract_points=timesfm_gate.get("sequence_contract_points"),
        )
        if timesfm_allowed
        else _skip_batch(f"TimesFM skipped by serving gate: {timesfm_gate.get('reason')}")
    )
    logger.info("[Pipeline V2] TimesFM serving gate: %s", timesfm_gate)
    state_space_mode = _state_space_overlay_mode()
    state_space_models = {
        model_name: _require_loaded_serving_version(active_versions, model_name, "ml_predict_task_plan")
        for model_name in ("KalmanFilter", "MarkovSwitching")
        if _is_optional_loaded_serving_model(model_status, model_name, "ml_predict_task_plan")
    }

    async def _shadow_state_space_overlays() -> dict:
        if not state_space_models:
            return {"error": "state-space overlays retired by model_pool", "results": []}
        if state_space_mode == "disabled":
            return {"error": "state-space overlays disabled by overlay mode", "results": []}
        if state_space_mode == "shadow":
            try:
                callback_url, callback_token = _state_space_shadow_callback_config()
                spawn_info = await asyncio.to_thread(
                    modal_client.spawn_state_space_overlays_batch_predict,
                    sequence_series,
                    horizon=5,
                    version_by_model=state_space_models,
                    run_date=state.get("run_date"),
                    run_id=state.get("producer_run_id") or state.get("run_id"),
                    callback_url=callback_url,
                    callback_token=callback_token,
                )
                logger.info(f"[Pipeline V2] State-space overlays shadow spawned: {spawn_info}")
                return {"error": "state-space overlays shadow spawned; not blocking prediction", "results": [], "shadow": spawn_info}
            except Exception as exc:  # noqa: BLE001 - shadow overlay must not block prediction.
                logger.warning(f"[Pipeline V2] State-space overlays shadow spawn failed: {exc}")
                return {"error": f"state-space overlays shadow spawn failed: {exc}", "results": []}
        overlay_call = modal_client.state_space_overlays_batch_predict(
            sequence_series,
            horizon=5,
            version_by_model=state_space_models,
        )
        soft_deadline = _state_space_overlay_soft_deadline_seconds()
        if soft_deadline:
            try:
                return await asyncio.wait_for(overlay_call, timeout=soft_deadline)
            except asyncio.TimeoutError:
                logger.warning(
                    "[Pipeline V2] State-space overlays soft deadline exceeded "
                    "deadline=%.1fs n_input=%s mode=%s",
                    soft_deadline,
                    len(sequence_series),
                    state_space_mode,
                )
                return {
                    "error": "state-space overlays soft deadline exceeded; continuing without overlays",
                    "results": [],
                    "soft_timeout": {
                        "deadline_seconds": soft_deadline,
                        "n_input": len(sequence_series),
                        "mode": state_space_mode,
                    },
                }
        return await overlay_call

    state_space_task = _shadow_state_space_overlays()
    (
        results,
        gnn_raw,
        dlinear_raw,
        patchtst_raw,
        state_space_raw,
        itransformer_raw,
        timesfm_raw,
    ) = await asyncio.gather(
        _timed_stage("predict_batch_v2", feat_task, required_alpha=True),
        _timed_stage("gnn_graphsage_universal_predict", gnn_task, required_alpha=True),
        _timed_stage("dlinear_universal_predict", dlinear_task, required_alpha=True),
        _timed_stage("patchtst_universal_predict", patchtst_task, required_alpha=True),
        _timed_stage("state_space_universal_predict", state_space_task, required_alpha=False),
        _timed_stage("itransformer_universal_predict", itransformer_task, required_alpha=True),
        _timed_stage("timesfm_universal_predict", timesfm_task, required_alpha=timesfm_allowed),
        return_exceptions=True,
    )

    gnn_result_summary = _modal_batch_result_summary(gnn_raw)
    modal_waiter = max((stage.get("wall_sec", 0.0) for stage in stage_timings.values()), default=0.0)
    critical_modal_waiter = max(
        (
            stage.get("wall_sec", 0.0)
            for stage in stage_timings.values()
            if stage.get("required_alpha")
        ),
        default=0.0,
    )
    slowest_stage = max(stage_timings.items(), key=lambda item: item[1].get("wall_sec", 0.0))[0] if stage_timings else None
    wait_telemetry = {
        "modal_waiter_sec": round(float(modal_waiter), 3),
        "critical_modal_waiter_sec": round(float(critical_modal_waiter), 3),
        "slowest_stage": slowest_stage,
        "stage_timings": stage_timings,
        "state_space_overlay_mode": state_space_mode,
        "state_space_soft_deadline_sec": _state_space_overlay_soft_deadline_seconds(),
        "timesfm_gate": timesfm_gate,
        "sequence_dataset": sequence_dataset_meta,
        "gnn_result_summary": gnn_result_summary,
        "n_input": n,
    }
    logger.info("[Pipeline V2] Modal wait telemetry: %s", wait_telemetry)
    try:
        from services.cost_tracker import record_compute_profile_event

        await record_compute_profile_event({
            "provider": "gcp_cloud_run",
            "job_name": "daily_pipeline_v2.ml_predict_wait",
            "source": "daily_pipeline_v2.node_ml_predict",
            "run_id": state.get("producer_run_id") or state.get("run_id"),
            "wall_sec": wait_telemetry["modal_waiter_sec"],
            "compute_sec": wait_telemetry["critical_modal_waiter_sec"],
            "cpu": 0,
            "memory_mb": 0,
            "gpu": None,
            "est_usd": 0.0,
            "symbols": n,
            "meta": wait_telemetry,
        })
    except Exception as exc:  # noqa: BLE001 - telemetry must never break serving.
        logger.debug("[Pipeline V2] Modal wait telemetry write skipped: %s", exc)


    def _active_required_model(model_name: str, series: list[dict]) -> bool:
        return _is_loaded_serving_model(model_status, model_name, "ml_predict_result_required") and bool(series)

    gnn_map: dict[str, dict] = {}
    if isinstance(gnn_raw, BaseException):
        if _active_required_model("GNN", payloads):
            raise RuntimeError(f"GNN active model batch failed entirely: {gnn_raw}") from gnn_raw
        logger.warning(f"[Pipeline V2] GNN GraphSAGE batch failed entirely: {gnn_raw}")
    elif isinstance(gnn_raw, dict) and not gnn_raw.get("error"):
        for gr in gnn_raw.get("results") or []:
            sym = gr.get("symbol")
            if sym and not gr.get("error") and gr.get("rank_score") is not None:
                gnn_map[sym] = gr
        if gnn_map:
            logger.info("[Pipeline V2] GNN GraphSAGE full-universe: %s/%s succeeded", len(gnn_map), len(payloads))
        else:
            if _active_required_model("GNN", payloads):
                raise RuntimeError(f"GNN active model returned zero usable predictions; summary={gnn_result_summary}")
            logger.warning("[Pipeline V2] GNN GraphSAGE full-universe: 0 succeeded summary=%s", gnn_result_summary)
    elif isinstance(gnn_raw, dict) and gnn_raw.get("results") == []:
        if _active_required_model("GNN", payloads):
            raise RuntimeError(f"GNN active model skipped unexpectedly: {gnn_raw.get('error')}")
        logger.debug(f"[Pipeline V2] GNN skipped: {gnn_raw.get('error')}")
    else:
        if _active_required_model("GNN", payloads):
            raise RuntimeError(f"GNN active model returned invalid payload: {gnn_raw}")
        logger.warning(f"[Pipeline V2] GNN batch returned error: {gnn_raw}")

    # Guard against DLinear total failure (Stage 0.2 ??may have no trained weights yet)
    dlinear_map: dict[str, dict] = {}
    if isinstance(dlinear_raw, BaseException):
        if _active_required_model("DLinear", sequence_model_series):
            raise RuntimeError(f"DLinear active model batch failed entirely: {dlinear_raw}") from dlinear_raw
        logger.warning(f"[Pipeline V2] DLinear batch failed entirely: {dlinear_raw}")
    elif isinstance(dlinear_raw, dict) and not dlinear_raw.get("error"):
        for dr in dlinear_raw.get("results") or []:
            sym = dr.get("symbol")
            if sym and not dr.get("error"):
                dlinear_map[sym] = dr
        if dlinear_map:
            logger.info(
                f"[Pipeline V2] DLinear universal: {len(dlinear_map)}/{len(sequence_series)} succeeded"
            )
        else:
            if _active_required_model("DLinear", sequence_model_series):
                raise RuntimeError("DLinear active model returned zero usable predictions")
            logger.info("[Pipeline V2] DLinear universal: 0 succeeded (likely no trained weights in GCS yet)")
    elif isinstance(dlinear_raw, dict) and dlinear_raw.get("results") == []:
        if _active_required_model("DLinear", sequence_model_series):
            raise RuntimeError(f"DLinear active model skipped unexpectedly: {dlinear_raw.get('error')}")
        logger.debug(f"[Pipeline V2] DLinear skipped: {dlinear_raw.get('error')}")
    else:
        if _active_required_model("DLinear", sequence_model_series):
            raise RuntimeError(f"DLinear active model returned invalid payload: {dlinear_raw}")
        logger.warning(f"[Pipeline V2] DLinear batch returned error: {dlinear_raw}")

    # Guard against PatchTST total failure (Stage 0.3 ??may have no trained weights yet)
    patchtst_map: dict[str, dict] = {}
    if isinstance(patchtst_raw, BaseException):
        if _active_required_model("PatchTST", sequence_model_series):
            raise RuntimeError(f"PatchTST active model batch failed entirely: {patchtst_raw}") from patchtst_raw
        logger.warning(f"[Pipeline V2] PatchTST batch failed entirely: {patchtst_raw}")
    elif isinstance(patchtst_raw, dict) and not patchtst_raw.get("error"):
        for pr in patchtst_raw.get("results") or []:
            sym = pr.get("symbol")
            if sym and not pr.get("error"):
                patchtst_map[sym] = pr
        if patchtst_map:
            logger.info(
                f"[Pipeline V2] PatchTST universal: {len(patchtst_map)}/{len(sequence_series)} succeeded"
            )
        else:
            if _active_required_model("PatchTST", sequence_model_series):
                raise RuntimeError("PatchTST active model returned zero usable predictions")
            logger.info("[Pipeline V2] PatchTST universal: 0 succeeded (likely no trained weights in GCS yet)")
    elif isinstance(patchtst_raw, dict) and patchtst_raw.get("results") == []:
        if _active_required_model("PatchTST", sequence_model_series):
            raise RuntimeError(f"PatchTST active model skipped unexpectedly: {patchtst_raw.get('error')}")
        logger.debug(f"[Pipeline V2] PatchTST skipped: {patchtst_raw.get('error')}")
    else:
        if _active_required_model("PatchTST", sequence_model_series):
            raise RuntimeError(f"PatchTST active model returned invalid payload: {patchtst_raw}")
        logger.warning(f"[Pipeline V2] PatchTST batch returned error: {patchtst_raw}")

    def _drain_ts_result(raw, name: str, series: list[dict]) -> dict[str, dict]:
        out: dict[str, dict] = {}
        required = timesfm_allowed if name == "TimesFM" else _active_required_model(name, series)
        if isinstance(raw, BaseException):
            if required:
                raise RuntimeError(f"{name} active model batch failed entirely: {raw}") from raw
            logger.warning(f"[Pipeline V2] {name} batch failed entirely: {raw}")
            return out
        if isinstance(raw, dict) and not raw.get("error"):
            for row in raw.get("results") or []:
                sym = row.get("symbol")
                if sym and not row.get("error"):
                    out[sym] = row
            summary = _modal_batch_result_summary(raw)
            error_summary = summary.get("error_summary")
            if len(out) == 0 and series and required:
                raise RuntimeError(
                    f"{name} active model returned zero usable predictions; "
                    f"contract_error_summary={error_summary or 'none'}"
                )
            if error_summary:
                logger.warning(
                    "[Pipeline V2] %s: %s/%s succeeded error_summary=%s",
                    name,
                    len(out),
                    len(series),
                    error_summary,
                )
            else:
                logger.info(f"[Pipeline V2] {name}: {len(out)}/{len(series)} succeeded")
        elif isinstance(raw, dict) and raw.get("results") == []:
            if required:
                raise RuntimeError(f"{name} active model skipped unexpectedly: {raw.get('error')}")
            logger.debug(f"[Pipeline V2] {name} skipped: {raw.get('error')}")
        else:
            if required:
                raise RuntimeError(f"{name} active model returned invalid payload: {raw}")
            logger.warning(f"[Pipeline V2] {name} batch returned error: {raw}")
        return out

    # Stage 6.2: KalmanFilter + MarkovSwitching state-space overlays.
    # They share one Modal call to avoid duplicate cold-start/import paths.
    def _drain_state_space(raw, name: str) -> dict[str, dict]:
        out: dict[str, dict] = {}
        if isinstance(raw, BaseException):
            logger.warning(f"[Pipeline V2] {name} batch failed: {raw}")
            return out
        if isinstance(raw, dict) and not raw.get("error"):
            blocked_count = 0
            blocked_reasons: dict[str, int] = {}
            for r in raw.get("results") or []:
                sym = r.get("symbol")
                if sym and not r.get("error"):
                    block_reason = _state_space_overlay_block_reason(r)
                    if block_reason:
                        blocked_count += 1
                        blocked_reasons[block_reason] = blocked_reasons.get(block_reason, 0) + 1
                        continue
                    out[sym] = r
            log_msg = f"[Pipeline V2] {name}: {len(out)}/{len(sequence_series)} usable blocked={blocked_count}"
            if blocked_count:
                logger.warning(f"{log_msg} reasons={blocked_reasons}")
            else:
                logger.info(log_msg)
        elif isinstance(raw, dict) and raw.get("results") == []:
            logger.debug(f"[Pipeline V2] {name} skipped: {raw.get('error')}")
        else:
            logger.warning(f"[Pipeline V2] {name} batch returned error: {raw}")
        return out
    state_space_overlays = {}
    if isinstance(state_space_raw, dict) and isinstance(state_space_raw.get("overlays"), dict):
        state_space_overlays = state_space_raw["overlays"]
        logger.info(f"[Pipeline V2] State-space overlays metrics: {state_space_raw.get('metrics')}")
    elif isinstance(state_space_raw, dict) and state_space_raw.get("shadow"):
        logger.info(f"[Pipeline V2] State-space overlays shadow mode: {state_space_raw.get('shadow')}")
    elif isinstance(state_space_raw, dict) and state_space_raw.get("soft_timeout"):
        logger.warning(f"[Pipeline V2] State-space overlays soft timeout: {state_space_raw.get('soft_timeout')}")
    elif isinstance(state_space_raw, dict) and state_space_raw.get("results") == []:
        logger.debug(f"[Pipeline V2] State-space overlays skipped: {state_space_raw.get('error')}")
    elif isinstance(state_space_raw, BaseException):
        logger.warning(f"[Pipeline V2] State-space overlays failed entirely: {state_space_raw}")
    else:
        logger.warning(f"[Pipeline V2] State-space overlays returned invalid payload: {state_space_raw}")
    kalman_raw = state_space_overlays.get("KalmanFilter", {})
    markov_raw = state_space_overlays.get("MarkovSwitching", {})
    kalman_map = _drain_state_space(kalman_raw, "KalmanFilter")
    markov_map = _drain_state_space(markov_raw, "MarkovSwitching")
    itransformer_map = _drain_ts_result(itransformer_raw, "iTransformer", sequence_series)
    timesfm_map = _drain_ts_result(timesfm_raw, "TimesFM", timesfm_sequence_series)
    # Guard against feature batch total failure
    if isinstance(results, BaseException):
        logger.error(f"[Pipeline V2] Feature batch_predict failed: {results}")
        return {"predictions": {}}

    def _attach_alt_sources(row: dict, sym: str) -> None:
        if sym in dlinear_map:
            row["dlinear"] = dlinear_map[sym]
        if sym in patchtst_map:
            row["patchtst"] = patchtst_map[sym]
        if sym in itransformer_map:
            row["itransformer"] = itransformer_map[sym]
        if sym in timesfm_map:
            row["timesfm"] = timesfm_map[sym]
        if sym in gnn_map:
            row["gnn"] = gnn_map[sym]
            rank_scores = row.get("rank_scores")
            if not isinstance(rank_scores, dict):
                rank_scores = {}
                row["rank_scores"] = rank_scores
            rank_scores["GNN"] = float(gnn_map[sym]["rank_score"])
        if sym in kalman_map:
            row["kalman_filter"] = kalman_map[sym]
        if sym in markov_map:
            row["markov_switching"] = markov_map[sym]

    feature_by_symbol: dict[str, dict] = {}
    feature_errors_by_symbol: dict[str, str] = {}
    for row in results:
        sym = row.get("symbol")
        if not sym:
            continue
        if row.get("error"):
            feature_errors_by_symbol[sym] = str(row.get("error"))
            continue
        feature_by_symbol[sym] = row

    pred_map: dict[str, dict] = {}
    feature_missing_count = 0
    for payload in payloads:
        sym = payload.get("symbol") if isinstance(payload, dict) else None
        if not sym:
            continue
        row = feature_by_symbol.get(sym)
        if row is None:
            feature_missing_count += 1
            continue
        if isinstance(payload, dict):
            row["stock_meta"] = payload.get("stock_meta") or {}
        _attach_alt_sources(row, sym)
        pred_map[sym] = row

    degenerate_scores = drop_degenerate_rank_scores(pred_map, score_field="rank_scores")
    degenerate_challengers = drop_degenerate_rank_scores(pred_map, score_field="challenger_rank_scores")
    if degenerate_scores:
        logger.warning(f"[Pipeline V2] Dropped degenerate active rank_scores: {degenerate_scores}")
    if degenerate_challengers:
        logger.warning(f"[Pipeline V2] Dropped degenerate challenger rank_scores: {degenerate_challengers}")

    error_count = sum(1 for r in results if r.get("error"))
    if error_count:
        sample_errors = [
            f"{sym}: {err}" for sym, err in list(feature_errors_by_symbol.items())[:5]
        ]
        logger.warning(f"[Pipeline V2] Feature batch returned {error_count} row errors; sample={sample_errors}")
    logger.info(
        f"[Pipeline V2] ML predict done: {len(pred_map)}/{n} succeeded, "
        f"{error_count} errors, "
        f"dlinear={sum(1 for v in pred_map.values() if 'dlinear' in v)}, "
        f"patchtst={sum(1 for v in pred_map.values() if 'patchtst' in v)}, "
        f"itransformer={sum(1 for v in pred_map.values() if 'itransformer' in v)}, "
        f"timesfm={sum(1 for v in pred_map.values() if 'timesfm' in v)}, "
        f"gnn={sum(1 for v in pred_map.values() if 'gnn' in v)}, "
        f"kalman={sum(1 for v in pred_map.values() if 'kalman_filter' in v)}, "
        f"markov={sum(1 for v in pred_map.values() if 'markov_switching' in v)}, "
        f"feature_missing_no_fallback={feature_missing_count}, "
        f"pool_versions={'ok' if pool_versions_loaded else 'missing'}, "
        f"challenger_shadow={sum(1 for v in pred_map.values() if v.get('challenger_rank_scores'))}"
    )

    # ?? A: ML_POOL ensemble merge (8 alpha models with lifecycle) ??
    # 2026-05-06: IC is lane-aware and empirical-Bayes shrunk before serving.
    # Short-sample negative IC no longer hard-zeros a model; confirmed negative
    # IC plus failed validation still fail-closed.
    model_status = serving_model_status
    degraded_dampening = serving_degraded_dampening
    ev2_cfg = serving_ev2_cfg
    used_pool = serving_used_pool
    pool = serving_pool
    if used_pool:
        for sym, r in pred_map.items():
            try:
                serving_ic = _build_serving_ic_bundle(pool, _prediction_market_segment(r), ev2_cfg)
                _attach_ensemble_v2(
                    r,
                    model_status,
                    serving_ic,
                    degraded_dampening,
                    ev2_cfg,
                    adaptive_params=state.get("adaptive_params") or {},
                )
            except Exception as e:
                logger.debug(f"[Pipeline V2] ensemble_v2 merge failed for {sym}: {e}")
        logger.info(
            f"[Pipeline V2] Ensemble V2 merged: {sum(1 for v in pred_map.values() if 'ensemble_v2' in v)}/{len(pred_map)} stocks "
            f"(degraded_dampening={degraded_dampening})"
        )

        # #B Option 1 Top-K override (2026-04-21): regression-on-rank predictions
        # compress to [0.43, 0.58] under realistic R簡 0.02-0.05, never hitting
        # absolute 0.70 BUY threshold. Industry-standard fix: sort top K by
        # avg_rank desc, force BUY regardless of absolute threshold. Confidence
        # override gives downstream (paper.ts morning-setup SQL + debate prompt)
        # the margin they need to distinguish promoted signals from edge HOLDs.
        # Retired path: detect stale config only; never force BUY from rank/top-K.
        legacy_topk_requested = bool(
            ev2_cfg.get("allowLegacyTopKOverride", False)
            or ev2_cfg.get("topKOverrideEnabled", False)
        )
        if legacy_topk_requested:
            logger.warning(
                "[Pipeline V2] legacy_topk_override_retired: config requested top-K override, "
                "but sparse allocator is the final owner and forced BUY is disabled"
            )
    else:
        logger.info("[Pipeline V2] Ensemble V2 skip (model_pool.json not initialized)")

    dispersion = build_prediction_dispersion_report(pred_map)
    logger.info(
        "[Pipeline V2] Prediction dispersion: "
        f"symbols={dispersion.get('n_symbols')} models={dispersion.get('n_models_seen')} "
        f"active_avg={dispersion.get('avg_active_weight_count')} "
        f"rank_std={dispersion.get('avg_raw_rank_std')} "
        f"merge_compression={dispersion.get('avg_merge_compression')} "
        f"flags={dispersion.get('flags')}"
    )
    return {
        "predictions": pred_map,
        "prediction_dispersion": dispersion,
        "modal_wait_telemetry": wait_telemetry,
    }


async def node_l2_cheap_ml_predict(state: PipelineStateV2) -> dict:
    """Run cheap tree-only ML before any formal L3 model family."""
    from services import modal_client

    payloads = state["payloads"]
    n = len(payloads)
    logger.info("[Pipeline V2] node_l2_cheap_ml_predict: %s stocks (tree-only coarse gate)", n)
    if not payloads:
        return {"l2_predictions": {}, "predictions": {}, "l3_payloads": []}

    started = time.time()
    results = await modal_client.l2_tree_batch_predict(payloads)
    wait_telemetry = {
        "modal_waiter_sec": round(time.time() - started, 3),
        "stage": "l2_tree_predict",
        "n_input": n,
        "n_result": len(results or []),
    }

    payload_by_symbol = {
        str(payload.get("symbol") or ""): payload
        for payload in payloads
        if isinstance(payload, dict) and payload.get("symbol")
    }
    pred_map: dict[str, dict] = {}
    row_errors: dict[str, str] = {}
    for row in results or []:
        if not isinstance(row, dict):
            continue
        symbol = str(row.get("symbol") or "")
        if not symbol:
            continue
        if row.get("error"):
            row_errors[symbol] = str(row.get("error"))
            continue
        payload = payload_by_symbol.get(symbol) or {}
        row = dict(row)
        row["stock_meta"] = payload.get("stock_meta") or {}
        pred_map[symbol] = row

    degenerate_scores = drop_degenerate_rank_scores(pred_map, score_field="rank_scores")
    if degenerate_scores:
        logger.warning("[Pipeline V2] L2 dropped degenerate tree rank_scores: %s", degenerate_scores)
    if row_errors:
        logger.warning(
            "[Pipeline V2] L2 tree batch returned %s row errors; sample=%s",
            len(row_errors),
            [f"{sym}: {err}" for sym, err in list(row_errors.items())[:5]],
        )
    logger.info("[Pipeline V2] L2 tree predict done: %s/%s succeeded", len(pred_map), n)
    return {
        "l2_predictions": pred_map,
        "predictions": pred_map,
        "l2_modal_wait_telemetry": wait_telemetry,
    }


def _timesfm_l175_registry_release_policy() -> dict[str, Any]:
    try:
        rows = d1_client.query(
            """
            SELECT artifact_id, model_name, version, state, feature_policy_version, source_run_date, updated_at
            FROM model_artifact_registry
            WHERE candidate_type = 'timesfm_l175_l2_feature_release'
              AND state IN ('approved', 'production')
            ORDER BY updated_at DESC
            LIMIT 50
            """,
            [],
            timeout=30.0,
        )
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Pipeline V2] TimesFM L1.75 registry release fallback skipped: %s", exc)
        return {}
    if not rows:
        return {}

    production_tree = [
        dict(row)
        for row in rows
        if str(row.get("state") or "") == "production"
        and str(row.get("model_name") or "") in {"LightGBM", "XGBoost", "ExtraTrees"}
    ]
    latest = dict(rows[0])
    return {
        "schema_version": "timesfm-l1-75-l2-feature-release-v1",
        "status": "production_approved" if production_tree else "approved",
        "source": "model_artifact_registry",
        "candidate_type": "timesfm_l175_l2_feature_release",
        "feature_schema": "formal137+timesfm_l175",
        "retrain_complete": True,
        "model_pool_released": bool(production_tree),
        "latest_artifact_id": latest.get("artifact_id"),
        "latest_model": latest.get("model_name"),
        "latest_version": latest.get("version"),
        "production_tree_artifacts": production_tree,
        "registry_rows": len(rows),
    }


def _timesfm_l175_release_policy() -> dict[str, Any]:
    try:
        policy = kv_client.get_json("ml:timesfm_l175_l2_feature_release", default={})
        if isinstance(policy, dict) and policy:
            return policy
    except Exception as exc:  # noqa: BLE001
        logger.debug("[Pipeline V2] TimesFM L1.75 release policy read skipped: %s", exc)
    return _timesfm_l175_registry_release_policy()


def _payload_with_timesfm_l175_sidecar(payload: dict, sidecar: dict[str, Any]) -> dict:
    out = dict(payload)
    stock_meta = dict(out.get("stock_meta") or {})
    runtime_options = dict(out.get("runtime_options") or {})
    active = bool(sidecar.get("l2_feature_input_active"))
    stock_meta["timesfm_l175_sidecar"] = sidecar
    stock_meta["timesfm_l175_l2_feature_input_active"] = active
    runtime_options["timesfm_l175_sidecar"] = sidecar
    runtime_options["timesfm_l175_l2_feature_input_active"] = active
    if active:
        stock_meta["timesfm_l175_features"] = dict(sidecar.get("features") or {})
        runtime_options["timesfm_l175_l2_feature_values"] = dict(sidecar.get("l2_feature_values") or {})
    out["stock_meta"] = stock_meta
    out["runtime_options"] = runtime_options
    return out


async def node_timesfm_l175_enrich(state: PipelineStateV2) -> dict:
    """Build TimesFM L1.75 sidecar features before L2 tree inference."""
    from services import modal_client

    payloads = state.get("payloads") or []
    if not payloads:
        return {"timesfm_l175_sidecars": {}, "timesfm_l175_summary": {"status": "skipped", "reason": "empty_payloads"}}

    release_policy = _timesfm_l175_release_policy()
    try:
        model_status, active_versions, _challenger_versions, _pool_versions_loaded = await asyncio.to_thread(_load_model_pool_versions)
        (
            serving_model_status,
            _serving_ic_universe,
            _serving_degraded_dampening,
            serving_ev2_cfg,
            _serving_used_pool,
            serving_pool,
        ) = await asyncio.to_thread(_load_pool_and_ic)
        if serving_model_status:
            model_status = {**model_status, **serving_model_status}

        base_sequence_series = build_state_space_series_from_payloads(payloads)
        sequence_series, sequence_dataset_meta = enrich_state_space_series_with_long_history(
            base_sequence_series,
            target_points=daily_sequence_target_points(),
        )
        timesfm_allowed, timesfm_gate = _timesfm_sync_gate(
            model_status=model_status,
            pool=serving_pool,
            ev2_cfg=serving_ev2_cfg,
            sequence_series=sequence_series,
        )
        if not timesfm_allowed:
            return {
                "timesfm_l175_sidecars": {},
                "timesfm_l175_summary": {
                    "status": "blocked",
                    "gate": timesfm_gate,
                    "sequence_dataset_meta": sequence_dataset_meta,
                },
            }

        sequence_contract_points = int(timesfm_gate.get("sequence_contract_points") or DEFAULT_TIMESFM_SEQUENCE_CONTRACT_POINTS)
        timesfm_sequence_series, excluded = _sequence_contract_subset(
            sequence_series,
            min_points=sequence_contract_points,
        )
        started = time.time()
        raw = await modal_client.timesfm_batch_predict(
            timesfm_sequence_series,
            version=_require_loaded_serving_version(active_versions, "TimesFM", "timesfm_l175_enrich"),
            sequence_contract_points=sequence_contract_points,
        )
        elapsed = round(time.time() - started, 3)
        result_rows = raw.get("results") if isinstance(raw, dict) else raw
        if not isinstance(result_rows, list):
            return {
                "timesfm_l175_sidecars": {},
                "timesfm_l175_summary": {
                    "status": "error",
                    "reason": "timesfm_batch_invalid_payload",
                    "gate": timesfm_gate,
                    "elapsed_sec": elapsed,
                },
            }

        timesfm_by_symbol = {
            str(row.get("symbol")): row
            for row in result_rows
            if isinstance(row, dict) and row.get("symbol") and not row.get("error")
        }
        payload_by_symbol = {
            str(payload.get("symbol")): payload
            for payload in payloads
            if isinstance(payload, dict) and payload.get("symbol")
        }
        sidecars: dict[str, dict] = {}
        enriched_payloads: list[dict] = []
        for payload in payloads:
            symbol = str(payload.get("symbol") or "")
            timesfm = timesfm_by_symbol.get(symbol)
            if not timesfm:
                enriched_payloads.append(payload)
                continue
            data = {
                **(payload_by_symbol.get(symbol) or {}),
                "timesfm": timesfm,
            }
            sidecar = build_timesfm_l175_sidecar(data, release_policy=release_policy)
            if not sidecar:
                enriched_payloads.append(payload)
                continue
            sidecars[symbol] = sidecar
            enriched_payloads.append(_payload_with_timesfm_l175_sidecar(payload, sidecar))

        active_count = sum(1 for sidecar in sidecars.values() if sidecar.get("l2_feature_input_active"))
        summary = {
            "status": "ready",
            "layer": "L1.75",
            "sidecar_count": len(sidecars),
            "l2_feature_input_active_count": active_count,
            "l2_feature_input_blocked_count": len(sidecars) - active_count,
            "release_policy": sidecars[next(iter(sidecars))].get("release_evidence") if sidecars else release_policy,
            "gate": timesfm_gate,
            "excluded_count": len(excluded),
            "excluded_symbols": excluded[:20],
            "elapsed_sec": elapsed,
            "sequence_dataset_meta": sequence_dataset_meta,
        }
        logger.info("[Pipeline V2] TimesFM L1.75 sidecar summary: %s", summary)
        return {
            "payloads": enriched_payloads,
            "timesfm_l175_sidecars": sidecars,
            "timesfm_l175_summary": summary,
        }
    except Exception as exc:  # noqa: BLE001 - L1.75 sidecar must not break L2.
        logger.warning("[Pipeline V2] TimesFM L1.75 sidecar failed: %s", exc)
        return {
            "timesfm_l175_sidecars": {},
            "timesfm_l175_summary": {
                "status": "error",
                "reason": f"{type(exc).__name__}: {exc}",
            },
        }


async def node_l2_core_gate(state: PipelineStateV2) -> dict:
    """Attach L2 tree evidence and build the bounded L3 formal inference queue."""
    from services.trading_config_loader import load_merged_trading_config_with_contract

    cfg_result = load_merged_trading_config_with_contract()
    _require_trading_config_contract(cfg_result, "l2_core_gate")
    trading_cfg = cfg_result.config

    screener_sizing = resolve_controller_screener_sizing(
        trading_cfg,
        state.get("adaptive_params"),
    )
    target_size = _resolve_coarse_ml_gate_target(
        len(state.get("screener_recs") or []),
        screener_sizing,
        trading_cfg,
    )
    l2_predictions = dict(state.get("l2_predictions") or state.get("predictions") or {})
    gated_predictions, selected_symbols, summary = _attach_l2_core_ml_evidence(
        l2_predictions,
        target_size=target_size,
        upstream_count=len(state.get("screener_recs") or []),
    )
    l3_payloads = _payloads_for_symbols(state.get("payloads") or [], selected_symbols)
    summary["l3_payload_count"] = len(l3_payloads)
    logger.info(
        "[Pipeline V2] L2 tree evidence queued %s/%s candidates for L3 formal inference (target=%s)",
        len(selected_symbols),
        len(state.get("screener_recs") or []),
        target_size,
    )
    return {
        "l2_predictions": gated_predictions,
        "predictions": gated_predictions,
        "l2_selected_symbols": selected_symbols,
        "l2_core_ml_evidence_summary": summary,
        "l2_core_ml_gate_summary": summary,
        "l3_payloads": l3_payloads,
    }


async def node_l3_formal_predict(state: PipelineStateV2) -> dict:
    """Run formal L3 families only on the L2 shortlist, then merge evidence."""
    l3_payloads = state.get("l3_payloads") or []
    l2_predictions = dict(state.get("l2_predictions") or state.get("predictions") or {})
    if not l3_payloads:
        logger.warning("[Pipeline V2] node_l3_formal_predict skipped: no L2-selected payloads")
        return {
            "predictions": l2_predictions,
            "l3_predictions": {},
            "prediction_dispersion": build_prediction_dispersion_report(l2_predictions),
        }

    logger.info(
        "[Pipeline V2] node_l3_formal_predict: %s L2-selected stocks (formal family ML)",
        len(l3_payloads),
    )
    l3_state = dict(state)
    l3_state["payloads"] = l3_payloads
    l3_result = await node_ml_predict(l3_state)
    l3_predictions = dict(l3_result.get("predictions") or {})
    merged_predictions = dict(l2_predictions)
    for symbol, row in l3_predictions.items():
        base = dict(l2_predictions.get(symbol) or {})
        core_ml_evidence = base.get("core_ml_evidence") or base.get("core_ml_gate")
        merged = {**base, **row}
        if core_ml_evidence is not None:
            merged["core_ml_evidence"] = core_ml_evidence
            merged["core_ml_gate"] = core_ml_evidence
        merged["prediction_stage"] = "L3"
        merged_predictions[symbol] = merged

    dispersion = build_prediction_dispersion_report(merged_predictions)
    logger.info(
        "[Pipeline V2] L3 formal predict merged: %s/%s L2 candidates, total predictions=%s",
        len(l3_predictions),
        len(l3_payloads),
        len(merged_predictions),
    )
    return {
        "predictions": merged_predictions,
        "l3_predictions": l3_predictions,
        "prediction_dispersion": dispersion,
        "modal_wait_telemetry": l3_result.get("modal_wait_telemetry"),
        "l3_modal_wait_telemetry": l3_result.get("modal_wait_telemetry"),
    }


# ?????????????????????????????????????????????????????????????????????????????
# A: ML_POOL-aware ensemble merge helpers (pure Python, no Modal)
# ?????????????????????????????????????????????????????????????????????????????


def _load_model_pool_versions() -> tuple[dict[str, str], dict[str, str], dict[str, str], bool]:
    """Load active/challenger versions for batch predictors.

    Returns (status_by_model, active_version_by_model, challenger_version_by_model, used_pool).
    model_pool.json is required so model activation and artifact versions have a
    single source of truth.
    """
    import json as _json
    import os

    try:
        from google.cloud import storage

        bucket_name = os.getenv("GCS_BUCKET_NAME")
        if not bucket_name:
            raise RuntimeError("GCS_BUCKET_NAME not set for model_pool version load")
        blob = storage.Client().bucket(bucket_name).blob("universal/model_pool.json")
        if not blob.exists():
            raise RuntimeError("universal/model_pool.json missing")

        pool = _json.loads(blob.download_as_text().lstrip("\ufeff"))
        _require_model_pool_active9_contract(pool, "model_pool_versions")
        status: dict[str, str] = {}
        active_versions: dict[str, str] = {}
        challenger_versions: dict[str, str] = {}
        for name, entry in (pool.get("models") or {}).items():
            if name in RETIRED_ALPHA_MODEL_SET or name not in ACTIVE_ALPHA_MODEL_SET:
                logger.warning("[Pipeline V2] Ignoring legacy/non-active-9 model_pool entry: %s", name)
                continue
            lifecycle_status = _require_model_pool_status(entry, name, "model_pool_versions")
            status[name] = lifecycle_status
            if lifecycle_status in MODEL_POOL_SERVING_STATUSES:
                active_versions[name] = _require_serving_model_version(entry, name, "model_pool_versions")
            challenger = entry.get("challenger") or {}
            if challenger.get("version"):
                challenger_versions[name] = challenger["version"]
        for name, entry in (pool.get("formal_layer3_slots") or {}).items():
            slot_status = str(entry.get("status") or "").strip()
            direct_prediction = bool(entry.get("direct_prediction")) or float(entry.get("vote_weight") or 0.0) > 0.0
            if direct_prediction and slot_status in {"production_adapter_active", "active"}:
                if name not in status:
                    status[name] = "retired"
                logger.warning(
                    "[Pipeline V2] Formal L3 slot %s ignored for activation: "
                    "production inference requires model_pool.models artifact path",
                    name,
                )
            elif name not in status:
                status[name] = "retired"
        for name, entry in (pool.get("state_overlays") or {}).items():
            lifecycle_status = _require_model_pool_status(entry, name, "model_pool_versions")
            status[name] = lifecycle_status
            if lifecycle_status in MODEL_POOL_SERVING_STATUSES:
                active_versions[name] = _require_serving_model_version(entry, name, "model_pool_versions")
        return status, active_versions, challenger_versions, True
    except Exception as e:
        raise RuntimeError(f"model_pool version load failed: {e}") from e


def _require_model_pool_active9_contract(pool: dict, stage: str) -> None:
    models = pool.get("models") if isinstance(pool, dict) else None
    if not isinstance(models, dict):
        raise RuntimeError(f"model_pool_contract:{stage}:models must be an object")
    missing = [
        name
        for name in ACTIVE_ALPHA_MODELS
        if not isinstance(models.get(name), dict)
    ]
    if missing:
        raise RuntimeError(
            f"model_pool_contract:{stage}:missing active-9 model entries: {', '.join(missing)}"
        )
    invalid = [
        f"{name}={models[name].get('status')}"
        for name in ACTIVE_ALPHA_MODELS
        if str(models[name].get("status") or "").strip() not in MODEL_POOL_ALLOWED_STATUSES
    ]
    if invalid:
        raise RuntimeError(
            f"model_pool_contract:{stage}:invalid lifecycle status: {', '.join(invalid)}"
        )


def _normalize_market_segment(segment: Any) -> str | None:
    value = str(segment or "").strip().upper()
    if value in {"TWSE", "TSE", "LISTED"}:
        return "LISTED"
    if value in {"TPEX", "OTC"}:
        return "OTC"
    if value in {"ESB", "EMERGING"}:
        return "EMERGING"
    return None


def _prediction_market_segment(pred: dict) -> str | None:
    meta = pred.get("stock_meta") if isinstance(pred.get("stock_meta"), dict) else {}
    return _normalize_market_segment(meta.get("market_segment") or meta.get("market"))


def _resolve_coarse_ml_gate_target(
    input_count: int,
    screener_sizing: dict[str, Any],
    trading_config: dict[str, Any] | None = None,
) -> int:
    """Resolve Layer 2 keep count from a ratio, not the legacy queue-size cap."""
    _ = screener_sizing
    if input_count <= 0:
        return 0
    config = trading_config if isinstance(trading_config, dict) else {}
    raw = config.get("screener") if isinstance(config.get("screener"), dict) else {}
    try:
        keep_ratio = float(raw.get("coarseMlKeepRatio", raw.get("coarse_ml_keep_ratio", 0.75)) or 0.75)
    except (TypeError, ValueError):
        keep_ratio = 0.75
    keep_ratio = max(0.25, min(1.0, keep_ratio))
    ratio_target = max(1, math.ceil(input_count * keep_ratio))
    return min(input_count, ratio_target)


def _resolve_core_family_evidence_target(
    input_count: int,
    screener_sizing: dict[str, Any],
    trading_config: dict[str, Any] | None = None,
) -> int:
    """Resolve Layer 3 evidence count; no longer a capacity gate."""
    if input_count <= 0:
        return 0
    return int(input_count)


def _resolve_core_family_rank_target(
    input_count: int,
    screener_sizing: dict[str, Any],
    trading_config: dict[str, Any] | None = None,
) -> int:
    """Deprecated compatibility wrapper; Layer 3 no longer rank-truncates."""
    return _resolve_core_family_evidence_target(input_count, screener_sizing, trading_config)


def _coerce_ic_value(value: Any) -> float | None:
    if isinstance(value, dict):
        for key in ("ic", "rolling_ic", "ic_4w_avg", "value"):
            if key in value:
                return _coerce_ic_value(value.get(key))
        return None
    try:
        if value is not None:
            return float(value)
    except (TypeError, ValueError):
        return None
    return None


def _entry_serving_ic(entry: dict, market_segment: str | None = None) -> tuple[float | None, str]:
    """Choose lane IC first; fall back to global lifecycle IC only when absent."""
    segment = _normalize_market_segment(market_segment)
    segment_map = entry.get("last_ic_by_segment")
    if segment and isinstance(segment_map, dict):
        segment_ic = _coerce_ic_value(segment_map.get(segment))
        if segment_ic is not None:
            return segment_ic, f"last_ic_by_segment.{segment}"

    for key in ("ic_4w_avg", "weekly_ic", "rolling_ic"):
        value = entry.get(key)
        if key == "weekly_ic":
            history = value or []
            value = history[-1] if history else None
        ic_value = _coerce_ic_value(value)
        if ic_value is not None:
            return ic_value, key
    evidence = entry.get("last_artifact_evidence")
    status = str(entry.get("last_ic_status") or "").strip().lower()
    if status in {"awaiting_live_ic", "artifact_oos_prior", "benchmark_evidence_pending_live_ic"} and isinstance(evidence, dict):
        artifact_ic = _coerce_ic_value(evidence.get("oos_ic") or evidence.get("after_oos_ic"))
        if artifact_ic is not None:
            return artifact_ic, "last_artifact_evidence.oos_ic"
    return None, "missing"


def _coerce_sample_count(value: Any) -> int | None:
    try:
        if value is not None:
            return max(0, int(float(value)))
    except (TypeError, ValueError):
        return None
    return None


def _entry_ic_sample_count(entry: dict, source: str) -> int:
    if source.startswith("last_ic_by_segment."):
        segment = source.split(".", 1)[1]
        segment_map = entry.get("last_ic_by_segment")
        segment_value = segment_map.get(segment) if isinstance(segment_map, dict) else None
        if isinstance(segment_value, dict):
            for key in ("n_samples", "sample_count", "samples", "coverage"):
                count = _coerce_sample_count(segment_value.get(key))
                if count is not None:
                    return count
    if source == "last_artifact_evidence.oos_ic":
        evidence = entry.get("last_artifact_evidence")
        if isinstance(evidence, dict):
            for key in ("oos_samples", "validation_sample_count", "matched_rows", "sample_count"):
                count = _coerce_sample_count(evidence.get(key))
                if count is not None:
                    return count
            row_alignment = evidence.get("row_alignment")
            if isinstance(row_alignment, dict):
                count = _coerce_sample_count(row_alignment.get("matched_rows"))
                if count is not None:
                    return count
    for key in ("last_ic_sample_count", "active_ic_samples", "ic_sample_count", "sample_count", "coverage_samples"):
        count = _coerce_sample_count(entry.get(key))
        if count is not None:
            return count
    history = entry.get("weekly_ic") or []
    if source == "weekly_ic" and isinstance(history, list):
        return len(history)
    return 0


def _ic_weighting_policy(ev2_cfg: dict | None = None) -> dict[str, Any]:
    raw = ((ev2_cfg or {}).get("icWeighting") or {}) if isinstance(ev2_cfg, dict) else {}
    return {
        "method": str(raw.get("method") or "empirical_bayes_shrinkage"),
        "enabled": bool(raw.get("enabled", True)),
        "prior_ic": float(raw.get("priorIc", raw.get("priorIC", 0.015)) or 0.015),
        "prior_strength": float(raw.get("priorStrength", 20.0) or 20.0),
        "min_samples_for_hard_zero": int(raw.get("minSamplesForHardZero", 40) or 40),
        "uncertain_negative_floor": float(raw.get("uncertainNegativeFloor", raw.get("pooledSegmentFloor", 0.0025)) or 0.0025),
        "pooled_segment_fallback_enabled": bool(raw.get("pooledSegmentFallbackEnabled", False)),
        "pooled_segment_floor": float(raw.get("pooledSegmentFloor", 0.0025) or 0.0025),
        "pooled_segment_fallback_multiplier": float(raw.get("pooledSegmentFallbackMultiplier", 0.25) or 0.25),
        "pooled_segment_cap": float(raw.get("pooledSegmentCap", 0.015) or 0.015),
    }


def _shrink_ic_weight(
    ic_value: float | None,
    sample_count: int,
    validation_multiplier: float,
    ev2_cfg: dict | None = None,
) -> tuple[float | None, dict[str, Any]]:
    policy = _ic_weighting_policy(ev2_cfg)
    if ic_value is None:
        return None, {"policy": policy["method"], "reason": "ic_missing"}
    raw_ic = float(ic_value)
    if not policy["enabled"]:
        effective = raw_ic * validation_multiplier
        return effective, {
            "policy": "raw_ic",
            "raw_ic": raw_ic,
            "sample_count": sample_count,
            "posterior_ic": raw_ic,
            "effective_weight": effective,
        }

    prior_strength = max(0.0, float(policy["prior_strength"]))
    n = max(0, int(sample_count or 0))
    alpha = n / (n + prior_strength) if (n + prior_strength) > 0 else 1.0
    posterior = (alpha * raw_ic) + ((1.0 - alpha) * float(policy["prior_ic"]))
    if n >= int(policy["min_samples_for_hard_zero"]) and raw_ic < 0 and posterior <= 0:
        effective = 0.0
        reason = "negative_ic_confirmed"
    elif raw_ic < 0 and posterior <= 0:
        # Low-sample segment IC is noisy; keep a tiny exploration floor instead of
        # freezing the model out before pooled/global evidence can recover it.
        effective = max(0.0, float(policy["uncertain_negative_floor"]))
        reason = "uncertain_negative_floor"
    else:
        effective = max(0.0, posterior)
        reason = "shrunk_to_prior"
    effective *= max(0.0, float(validation_multiplier or 0.0))
    return effective, {
        "policy": policy["method"],
        "raw_ic": raw_ic,
        "prior_ic": float(policy["prior_ic"]),
        "prior_strength": prior_strength,
        "sample_count": n,
        "shrink_alpha": round(alpha, 6),
        "posterior_ic": round(posterior, 8),
        "effective_weight": round(effective, 8),
        "reason": reason,
    }


def _validation_multiplier(entry: dict) -> tuple[float, str, str]:
    evidence = (
        entry.get("model_cpcv")
        or entry.get("validation_packet")
        or entry.get("promotion_gate")
        or entry.get("validation")
        or {}
    )
    if not isinstance(evidence, dict) or not evidence:
        return 1.0, "MISSING", "no_model_validation_evidence"
    decision = str(
        evidence.get("decision")
        or evidence.get("go_live_verdict")
        or evidence.get("status")
        or ""
    ).strip().upper()
    try:
        pbo_fail = evidence.get("pbo") is not None and float(evidence.get("pbo")) >= 0.50
    except (TypeError, ValueError):
        pbo_fail = False
    if decision == "FAIL" or pbo_fail:
        return 0.0, "FAIL", "cpcv_pbo_failed"
    if decision in {"WARN", "WARNING"}:
        return 0.5, "WARN", "validation_warning"
    if decision == "PASS":
        return 1.0, "PASS", "validation_pass"
    return 1.0, "UNKNOWN", "validation_evidence_unrecognized"


def _build_serving_ic_bundle(
    pool: dict | None,
    market_segment: str | None = None,
    ev2_cfg: dict | None = None,
) -> dict:
    scope = _normalize_market_segment(market_segment) or "GLOBAL"
    weights: dict[str, float] = {}
    diagnostics: dict[str, dict] = {}
    for name, entry in ((pool or {}).get("models") or {}).items():
        if name in RETIRED_ALPHA_MODEL_SET or name not in ACTIVE_ALPHA_MODEL_SET:
            continue
        ic_value, source = _entry_serving_ic(entry, None if scope == "GLOBAL" else scope)
        multiplier, validation_status, validation_reason = _validation_multiplier(entry)
        sample_count = _entry_ic_sample_count(entry, source)
        effective_weight, shrinkage = _shrink_ic_weight(ic_value, sample_count, multiplier, ev2_cfg)
        policy = _ic_weighting_policy(ev2_cfg)
        if (
            scope != "GLOBAL"
            and policy.get("pooled_segment_fallback_enabled")
            and float(effective_weight or 0.0) == 0.0
            and shrinkage.get("reason") == "negative_ic_confirmed"
            and multiplier > 0
        ):
            pooled_ic, pooled_source = _entry_serving_ic(entry, None)
            pooled_sample_count = _entry_ic_sample_count(entry, pooled_source)
            pooled_weight, pooled_shrinkage = _shrink_ic_weight(
                pooled_ic,
                pooled_sample_count,
                multiplier,
                ev2_cfg,
            )
            if pooled_weight is not None and pooled_weight > 0:
                fallback_weight = min(
                    float(policy["pooled_segment_cap"]),
                    max(
                        float(policy["pooled_segment_floor"]),
                        float(pooled_weight) * float(policy["pooled_segment_fallback_multiplier"]),
                    ),
                )
                effective_weight = fallback_weight
                shrinkage = {
                    **shrinkage,
                    "reason": "pooled_segment_floor",
                    "segment_reason": "negative_ic_confirmed",
                    "pooled_ic": pooled_ic,
                    "pooled_ic_source": pooled_source,
                    "pooled_ic_sample_count": pooled_sample_count,
                    "pooled_effective_weight": round(float(pooled_weight), 8),
                    "pooled_floor_weight": round(float(fallback_weight), 8),
                    "pooled_shrinkage_reason": pooled_shrinkage.get("reason"),
                }
        if effective_weight is not None:
            weights[name] = float(effective_weight)
        diagnostics[name] = {
            "scope": scope,
            "ic_value": ic_value,
            "ic_source": source,
            "ic_sample_count": sample_count,
            "ic_shrinkage": shrinkage,
            "validation_multiplier": multiplier,
            "validation_status": validation_status,
            "validation_reason": validation_reason,
            "last_ic_status": entry.get("last_ic_status"),
            "last_ic_root_cause": entry.get("last_ic_root_cause"),
            "last_ic_sample_count": entry.get("last_ic_sample_count"),
        }
    for name, entry in ((pool or {}).get("formal_layer3_slots") or {}).items():
        if not isinstance(entry, dict) or str(name) in ((pool or {}).get("models") or {}):
            continue
        slot_status = str(entry.get("status") or "").strip()
        try:
            vote_weight = float(entry.get("vote_weight") or 0.0)
        except (TypeError, ValueError):
            vote_weight = 0.0
        direct_prediction = bool(entry.get("direct_prediction")) or vote_weight > 0.0
        diagnostics[str(name)] = {
            "scope": scope,
            "ic_value": None,
            "ic_source": "formal_slot_metadata_only",
            "ic_sample_count": 0,
            "ic_shrinkage": {
                "reason": (
                    "formal_slot_missing_model_artifact"
                    if direct_prediction and slot_status in {"production_adapter_active", "active"}
                    else slot_status or "inactive"
                )
            },
            "validation_multiplier": 0.0,
            "validation_status": "INACTIVE",
            "validation_reason": "production_vote_requires_model_pool_artifact",
            "formal_slot_status": slot_status,
            "direct_prediction": direct_prediction,
            "vote_weight": vote_weight,
            "last_ic_status": entry.get("last_ic_status"),
            "last_ic_root_cause": entry.get("last_ic_root_cause"),
            "last_ic_sample_count": entry.get("last_ic_sample_count"),
        }
    return {"scope": scope, "weights": weights, "diagnostics": diagnostics}


def _adaptive_threshold_delta(adaptive_params: dict | None = None) -> tuple[float, dict[str, Any]]:
    params = adaptive_params or {}
    components = params.get("threshold_components") if isinstance(params.get("threshold_components"), dict) else None
    if components and components.get("effective_delta") is not None:
        try:
            delta = float(components.get("effective_delta") or 0.0)
        except (TypeError, ValueError):
            delta = 0.0
        return delta, {
            "source": "threshold_components.effective_delta",
            "effective_delta": round(delta, 4),
            "components": components,
            "provenance": params.get("provenance") if isinstance(params.get("provenance"), dict) else {},
        }

    try:
        delta = float(params.get("confidence_delta") or 0.0)
    except (TypeError, ValueError):
        delta = 0.0
    return delta, {
        "source": "confidence_delta_legacy",
        "effective_delta": round(delta, 4),
        "components": None,
        "provenance": params.get("provenance") if isinstance(params.get("provenance"), dict) else {},
    }


def _resolve_alpha_regime_label(
    raw_regime: Any,
    regime_meta: dict | None,
    adaptive_params: dict | None,
) -> str:
    """Resolve alpha-framework regime from the canonical pre-pipeline contract."""
    candidates: list[Any] = [raw_regime]
    if isinstance(regime_meta, dict):
        candidates.extend([
            regime_meta.get("regime"),
            regime_meta.get("current_regime"),
            regime_meta.get("dominant_regime"),
        ])
    if isinstance(adaptive_params, dict):
        provenance = adaptive_params.get("provenance")
        components = adaptive_params.get("threshold_components")
        inputs = components.get("inputs") if isinstance(components, dict) else None
        if isinstance(provenance, dict):
            candidates.append(provenance.get("regime"))
        if isinstance(inputs, dict):
            candidates.append(inputs.get("regime"))

    for candidate in candidates:
        value = str(candidate or "").strip().lower()
        if value and value not in {"unknown", "none", "null", "n/a"}:
            return value
    return "unknown"


def _rank_signal_thresholds(ev2_cfg: dict | None, adaptive_params: dict | None = None) -> dict[str, float]:
    cfg = ev2_cfg or {}
    delta, _meta = _adaptive_threshold_delta(adaptive_params)

    def clipped(value: float) -> float:
        return max(0.01, min(0.99, value))

    return {
        "strongBuyThreshold": clipped(float(cfg.get("strongBuyThreshold", 0.85)) + delta),
        "buyThreshold": clipped(float(cfg.get("buyThreshold", 0.70)) + delta),
        "sellThreshold": clipped(float(cfg.get("sellThreshold", 0.30)) - delta),
        "strongSellThreshold": clipped(float(cfg.get("strongSellThreshold", 0.15)) - delta),
    }


def _load_pool_and_ic():
    """Synchronous loader (called via asyncio.to_thread).

    Returns:
      (model_status, ic_weights, degraded_dampening, ev2_cfg, used_pool, pool)

    2026-04-19 R1+R3 hybrid:
      - model_status: per-model "active"/"degraded"/"challenger"/"retired"
      - ic_weights: from model_pool.json rolling_ic/ic_4w_avg/latest weekly_ic
      - degraded_dampening: from trading:config.mlPool.degradedDampening
      - ev2_cfg: from trading:config.ensemble_v2 thresholds + Top-K override
        config (#B Option 1 2026-04-21 fix for "bot no-buy" mystery).
    """
    import json as _json
    import os
    try:
        from google.cloud import storage
        bucket_name = os.getenv("GCS_BUCKET_NAME")
        if not bucket_name:
            raise RuntimeError("GCS_BUCKET_NAME not set for model_pool / IC load")
        bucket = storage.Client().bucket(bucket_name)
        pool_blob = bucket.blob("universal/model_pool.json")
        if not pool_blob.exists():
            raise RuntimeError("universal/model_pool.json missing")
        pool = _json.loads(pool_blob.download_as_text().lstrip("\ufeff"))
        _require_model_pool_active9_contract(pool, "load_pool_and_ic")
        model_status: dict[str, str] = {}
        ic_weights: dict[str, float] = {}
        for name, entry in pool.get("models", {}).items():
            if name in RETIRED_ALPHA_MODEL_SET or name not in ACTIVE_ALPHA_MODEL_SET:
                logger.warning("[Pipeline V2] Ignoring legacy/non-active-9 model_pool IC entry: %s", name)
                continue
            model_status[name] = _require_model_pool_status(entry, name, "load_pool_and_ic")
            last_status = str(entry.get("last_ic_status") or "").strip()
            last_root_cause = str(entry.get("last_ic_root_cause") or "").strip()
            has_fresh_diagnostics = bool(last_status or last_root_cause)
            if has_fresh_diagnostics and not (last_status == "computed" and last_root_cause in ("", "ok")):
                continue
            ic_value = entry.get("rolling_ic")
            if ic_value is None:
                ic_value = entry.get("ic_4w_avg")
            if ic_value is None:
                history = entry.get("weekly_ic") or []
                if history:
                    ic_value = history[-1]
            try:
                if ic_value is not None:
                    ic_weights[name] = float(ic_value)
            except (TypeError, ValueError):
                logger.debug(f"[Pipeline V2] invalid model_pool IC for {name}: {ic_value}")

        for name, entry in (pool.get("formal_layer3_slots") or {}).items():
            slot_status = str(entry.get("status") or "").strip()
            direct_prediction = bool(entry.get("direct_prediction")) or float(entry.get("vote_weight") or 0.0) > 0.0
            if direct_prediction and slot_status in {"production_adapter_active", "active"}:
                if name not in model_status:
                    model_status[name] = "retired"
                ic_value = entry.get("rolling_ic") or entry.get("ic_4w_avg")
                try:
                    if ic_value is not None:
                        logger.warning(
                            "[Pipeline V2] Formal L3 IC for %s ignored: "
                            "production ensemble weight requires model_pool.models artifact path",
                            name,
                        )
                except (TypeError, ValueError):
                    logger.debug(f"[Pipeline V2] invalid formal L3 IC for {name}: {ic_value}")
            elif name not in model_status:
                model_status[name] = "retired"

        # IC weights have exactly one owner: model_pool.json. Missing IC stays
        # missing so lifecycle diagnostics can explain the root cause.
        # KV-driven degraded dampening + ensemble_v2 thresholds / Top-K cfg
        degraded_dampening = DEFAULT_DEGRADED_DAMPENING
        ev2_cfg: dict = {}
        try:
            from services.trading_config_loader import load_merged_trading_config_with_contract
            cfg_result = load_merged_trading_config_with_contract()
            _require_trading_config_contract(cfg_result, "load_pool_and_ic")
            tcfg = cfg_result.config
            degraded_dampening = resolve_degraded_dampening(tcfg)
            ev2_cfg = dict(tcfg.get("ensemble_v2", {}) or {})
            if ev2_cfg.get("expectedReturnCalibration"):
                configured = ev2_cfg.get("expectedReturnCalibration") or {}
                ev2_cfg["expectedReturnCalibrationRuntime"] = {
                    "status": "configured",
                    "source": configured.get("source") if isinstance(configured, dict) else "trading_config",
                    "sampleCount": configured.get("sampleCount") if isinstance(configured, dict) else None,
                    "binCount": len(configured.get("bins") or []) if isinstance(configured, dict) else None,
                }
            else:
                calibration_report = _load_expected_return_calibration_report()
                calibration = calibration_report.get("calibration")
                ev2_cfg["expectedReturnCalibrationRuntime"] = {
                    key: value for key, value in calibration_report.items()
                    if key != "calibration"
                }
                if calibration:
                    ev2_cfg["expectedReturnCalibration"] = calibration
                logger.info(
                    "[Pipeline V2] expected-return calibration %s "
                    "(samples=%s rows=%s bins=%s)",
                    calibration_report.get("status"),
                    calibration_report.get("sampleCount"),
                    calibration_report.get("rowCount"),
                    calibration_report.get("binCount"),
                )
        except Exception as _e:
            raise RuntimeError(f"trading:config contract unavailable for ensemble_v2 attach: {_e}") from _e
        return model_status, ic_weights, degraded_dampening, ev2_cfg, True, pool
    except Exception as e:
        raise RuntimeError(f"_load_pool_and_ic failed: {e}") from e


def _load_expected_return_calibration(
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
) -> dict[str, Any] | None:
    return _load_expected_return_calibration_report(
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_bin_samples=min_bin_samples,
        max_bins=max_bins,
    ).get("calibration")


def _load_expected_return_calibration_report(
    *,
    lookback_days: int = 90,
    min_samples: int = 30,
    min_bin_samples: int = 8,
    max_bins: int = 8,
) -> dict[str, Any]:
    """Build empirical avg_rank -> realized return calibration with explicit diagnostics."""
    return load_expected_return_calibration_report(
        d1_client.query,
        lookback_days=lookback_days,
        min_samples=min_samples,
        min_bin_samples=min_bin_samples,
        max_bins=max_bins,
    )


def _attach_ensemble_v2(
    pred: dict,
    model_status: dict,
    ic_weights: dict,
    degraded_dampening: float,
    ev2_cfg: dict | None = None,
    *,
    adaptive_params: dict | None = None,
) -> None:
    bundle = ic_weights if isinstance(ic_weights, dict) and "weights" in ic_weights else None
    serving_weights = bundle.get("weights", {}) if bundle else ic_weights
    thresholds = _rank_signal_thresholds(ev2_cfg, adaptive_params)
    adaptive_threshold_delta, adaptive_threshold_meta = _adaptive_threshold_delta(adaptive_params)
    effective_cfg = {**(ev2_cfg or {}), **thresholds}
    if isinstance(adaptive_params, dict):
        allocator_policy = (
            adaptive_params.get("model_allocator")
            or adaptive_params.get("allocator_policy")
            or adaptive_params.get("modelAllocatorPolicy")
        )
        if isinstance(allocator_policy, dict):
            effective_cfg["allocatorPolicy"] = allocator_policy
        learning_policy = (
            adaptive_params.get("model_allocator_learning_policy")
            or adaptive_params.get("allocator_learning_policy")
            or adaptive_params.get("learning_weight_policy")
        )
        if isinstance(learning_policy, dict):
            effective_cfg["allocatorLearningPolicy"] = learning_policy
    if bundle:
        effective_cfg["observedIcModels"] = [
            name for name, diag in (bundle.get("diagnostics") or {}).items()
            if isinstance(diag, dict) and diag.get("ic_value") is not None
        ]
    attach_ensemble_v2(pred, model_status, serving_weights, degraded_dampening, effective_cfg)
    ev2 = pred.get("ensemble_v2")
    if isinstance(ev2, dict):
        ev2["ic_weight_scope"] = (bundle or {}).get("scope") or _prediction_market_segment(pred) or "GLOBAL"
        ev2["rank_signal_thresholds"] = {k: round(float(v), 4) for k, v in thresholds.items()}
        ev2["adaptive_threshold"] = {
            **adaptive_threshold_meta,
            "applied_delta": round(float(adaptive_threshold_delta), 4),
        }
        if bundle:
            ev2["ic_weight_diagnostics"] = bundle.get("diagnostics") or {}

async def node_compute_personas(state: PipelineStateV2) -> dict:
    """
    Taiwan-persona augmentation layer (?縑 + ?? contrarian).

    For each active stock with a payload, compute two opinions using
    chip_data (trust_net) and margin_data (margin_balance) already loaded
    into the payload, plus concept-level PTT sentiment via stock_tags ??
    concept_buzz.

    Written to persona_opinions D1 table AND returned in state for the
    recommendation node (Phase 2 score integration).

    Non-fatal: failures log a warning but do not block the pipeline.
    """
    logger.info("[Pipeline V2] node_compute_personas")
    run_date = state["run_date"]
    payloads = state.get("payloads") or []
    if not payloads:
        return {"persona_opinions": {}}

    # ?? Bulk-load concept sentiment: symbol ??best_concept ??sentiment_avg ??
    # One query each for tags + buzz, then join in memory. Keeps D1 QPS low.
    symbols = [p.get("stock_id") or p.get("symbol") for p in payloads]
    symbols = [s for s in symbols if s]
    sentiment_by_symbol: dict[str, float] = {}
    try:
        # Top concept per symbol (highest weight)
        tag_rows: list[dict[str, Any]] = []
        for chunk in _d1_bind_chunks(list(symbols)):
            placeholders = ",".join("?" * len(chunk))
            tag_rows.extend(d1_client.query(
                f"SELECT symbol, tag FROM stock_tags WHERE tag_type = 'concept' AND symbol IN ({placeholders}) "
                f"ORDER BY symbol, weight DESC",
                chunk,
            ) or [])
        top_concept_by_symbol: dict[str, str] = {}
        for r in tag_rows or []:
            sym = r.get("symbol")
            if sym and sym not in top_concept_by_symbol:
                top_concept_by_symbol[sym] = r.get("tag")

        # Today's concept_buzz sentiment for those concepts
        concepts = list({c for c in top_concept_by_symbol.values() if c})
        if concepts:
            buzz_rows: list[dict[str, Any]] = []
            for chunk in _d1_bind_chunks(concepts):
                cp_placeholders = ",".join("?" * len(chunk))
                buzz_rows.extend(d1_client.query(
                    f"SELECT concept, sentiment_avg FROM concept_buzz "
                    f"WHERE date = ? AND concept IN ({cp_placeholders})",
                    [run_date, *chunk],
                ) or [])
            sent_by_concept: dict[str, float] = {}
            for r in buzz_rows or []:
                c = r.get("concept")
                s = r.get("sentiment_avg")
                if c is not None and s is not None:
                    sent_by_concept[c] = float(s)
            for sym, concept in top_concept_by_symbol.items():
                if concept in sent_by_concept:
                    sentiment_by_symbol[sym] = sent_by_concept[concept]
    except Exception as e:
        logger.warning(f"[Pipeline V2] persona sentiment lookup failed (non-fatal): {e}")

    # ?? Compute per-symbol opinions ?????????????????????????????????????????
    from datetime import date as _date
    try:
        today_dt = _date.fromisoformat(run_date)
    except Exception:
        today_dt = _date.today()

    opinions: list[PersonaOpinions] = []
    opinions_dict: dict[str, dict] = {}
    for p in payloads:
        sym = p.get("stock_id") or p.get("symbol")
        if not sym:
            continue
        chips = p.get("chips") or []
        if not chips:
            continue

        chip_bars: list[ChipBar] = []
        margin_bars: list[MarginBar] = []
        for row in chips:
            d = row.get("date")
            if not d:
                continue
            tn = row.get("trust_net")
            if tn is not None:
                chip_bars.append(ChipBar(date=str(d), trust_net=float(tn)))
            mb = row.get("margin_balance")
            if mb is not None:
                margin_bars.append(MarginBar(date=str(d), margin_balance=float(mb)))

        sentiment = sentiment_by_symbol.get(sym)

        try:
            trust = compute_trust_opinion(chip_bars, today_dt)
            retail = compute_retail_opinion(margin_bars, sentiment)
        except Exception as e:
            logger.warning(f"[Pipeline V2] persona compute failed for {sym}: {e}")
            continue

        opinions.append(PersonaOpinions(
            symbol=sym, date=run_date, trust=trust, retail=retail,
        ))
        opinions_dict[sym] = {
            "trust": trust.to_dict(),
            "retail": retail.to_dict(),
        }

    # ?? Persist to D1 (non-fatal) ???????????????????????????????????????????
    try:
        written = write_persona_opinions(d1_client, opinions)
        logger.info(f"[Pipeline V2] persona opinions written: {written}/{len(opinions)}")
    except Exception as e:
        logger.warning(f"[Pipeline V2] persona D1 write failed (non-fatal): {e}")

    return {"persona_opinions": opinions_dict}


async def node_compute_sector_flow(state: PipelineStateV2) -> dict:
    """
    Phase 6: Compute RRG (rs_ratio / rs_momentum / quadrant) for concept + industry
    and upsert into sector_flow. Screener consumes the latest completed sector_flow
    before this pipeline starts, so this refresh is post-write evidence for
    dashboards and the next screener run. It must not contend with the hot-path
    market_env reads.

    Runs sync work in a thread to avoid blocking the event loop (d1_client is sync).
    """
    logger.info("[Pipeline V2] node_compute_sector_flow")
    run_date = state["run_date"]
    try:
        summary = await asyncio.to_thread(run_sector_flow_pipeline, run_date)
        return {"sector_flow_summary": summary}
    except Exception as e:
        logger.error(f"[Pipeline V2] sector_flow failed (non-fatal): {e}")
        return {"sector_flow_summary": {}, "errors": [f"sector_flow: {e}"]}


async def node_recommend(state: PipelineStateV2) -> dict:
    """
    Filter SELL, compute canonical Score V2 finalScore, then run L2/L3 ranking and sparse allocation.
    """
    logger.info("[Pipeline V2] node_recommend")

    # Phase 2: persona weight is KV-controllable for safe rollout
    #   ml:persona_score_weight ??float, default 1.0, 0 = disabled, 0.5 = shadow
    try:
        persona_weight = float(
            kv_client.get_json("ml:persona_score_weight", default=1.0) or 1.0
        )
    except Exception:
        persona_weight = 1.0
    persona_weight = max(0.0, min(2.0, persona_weight))  # clamp [0, 2] safety bound
    regime_contract = resolve_market_regime_contract(kv_client)
    if regime_contract.get("missing"):
        regime_contract = build_market_regime_contract_from_market_env(
            state.get("market_env"),
            run_date=state.get("run_date"),
        )
        logger.warning(
            "[Pipeline V2] market_regime_state missing in KV; using %s for run_date=%s",
            regime_contract.get("source"),
            state.get("run_date"),
        )
    regime_label = str(regime_contract.get("alpha_regime") or "unknown")
    regime_surface = regime_contract.get("regime_surface") if isinstance(regime_contract.get("regime_surface"), dict) else {}
    if regime_contract.get("missing") or regime_label == "unknown":
        raise RuntimeError(
            "market_regime_state missing before recommendation; run regime-compute before pipeline"
        )

    from services.trading_config_loader import load_merged_trading_config_with_contract
    cfg_result = load_merged_trading_config_with_contract()
    _require_trading_config_contract(cfg_result, "recommend")
    trading_cfg = cfg_result.config
    alpha_policy = trading_cfg.get("alphaFramework", {}) or trading_cfg.get("alpha_framework", {}) or {}
    screener_recs = state["screener_recs"]
    if not screener_recs:
        raise RuntimeError(
            "screener_recs_missing: daily pipeline requires full-market screener "
            "seeds before ML/recommendation; refusing watchlist fallback"
        )

    fundamental_quality_by_symbol = load_fundamental_quality_by_symbol(screener_recs, state["run_date"])

    final, sell_count = filter_and_score_recommendations(
        screener_recs,
        state["predictions"],
        state["payloads"],
        persona_opinions=state.get("persona_opinions") or {},
        persona_weight=persona_weight,
        regime_label=regime_label,
        regime_surface=regime_surface,
        alpha_policy=alpha_policy,
        fundamental_quality_by_symbol=fundamental_quality_by_symbol,
    )
    screener_sizing = resolve_controller_screener_sizing(
        trading_cfg,
        state.get("adaptive_params"),
    )
    core_ml_target_size = _resolve_coarse_ml_gate_target(
        len(screener_recs),
        screener_sizing,
        trading_cfg,
    )
    final = apply_core_ml_evidence(
        final,
        state["predictions"],
        fallback_size=core_ml_target_size,
    )
    layer2_symbols = [str(row.get("symbol") or "") for row in final if row.get("symbol")]
    layer2_count = len(final)
    logger.info(
        "[Pipeline V2] Layer2 core_ml_evidence attached to %s/%s candidates (l3_queue_target=%s)",
        layer2_count,
        len(screener_recs),
        core_ml_target_size,
    )
    core_family_target_size = _resolve_core_family_evidence_target(
        layer2_count,
        screener_sizing,
        trading_cfg,
    )
    final = apply_core_family_evidence(
        final,
        state["predictions"],
        target_size=core_family_target_size,
        require_lifecycle_weights=True,
    )
    active_family_counts = [
        int(((row.get("core_family_evidence") or row.get("core_family_vote") or {}).get("active_family_count") or 0))
        for row in final
    ]
    logger.info(
        "[Pipeline V2] Layer3 core_family_evidence attached to %s/%s candidates "
        "(evidence_count=%s, active_family_counts=%s)",
        len(final),
        len(state["predictions"]),
        core_family_target_size,
        sorted(set(active_family_counts)),
    )
    return_history = build_return_history_from_payloads(state["payloads"])

    ranking_cfg = trading_cfg.get("ranking", {"enabled": True,
                                              "alpha": 0.40, "beta": 0.40, "gamma": 0.20,
                                              "screenerDenominator": 60.0, "promoteMinConf": 0.60})
    ev2_cfg = trading_cfg.get("ensemble_v2", {}) or {}
    final = apply_sparse_tangent_allocation(
        final,
        ranking_cfg,
        ev2_cfg,
        regime_label=regime_label,
        regime_surface=regime_surface,
        alpha_policy=alpha_policy,
        return_history=return_history,
    )
    for row in final:
        allocation = row.get("alpha_allocation")
        symbol = row.get("symbol")
        if allocation and symbol in state["predictions"]:
            state["predictions"][symbol]["alpha_allocation"] = allocation

    # Track which symbols were filtered out (for D1 delete in write_d1)
    final_syms = {r["symbol"] for r in final}
    filtered_syms = [r["symbol"] for r in screener_recs if r["symbol"] not in final_syms]

    logger.info(
        f"[Pipeline V2] Recommend done: {len(final)} kept, {sell_count} SELL filtered"
    )
    return {
        "final_recommendations": final,
        "layer2_recommendation_symbols": layer2_symbols,
        "layer3_formal_gate_target_size": core_family_target_size,
        "sell_filtered_symbols": filtered_syms,
    }


async def node_llm_reasons(state: PipelineStateV2) -> dict:
    """
    Generate Gemini reasons plus advisory-only Breeze2 trade-plan shadow.
    """
    logger.info("[Pipeline V2] node_llm_reasons")
    candidates = state["final_recommendations"]
    if not candidates:
        return {"llm_reasons": {}, "breeze2_reason_shadow": {}}

    # Top themes from sector_flow_summary (Phase 6 ??node_compute_sector_flow populates)
    # Optional context for LLM prompt; empty list is acceptable fallback.
    top_themes: list[str] = []
    sf = state.get("sector_flow_summary") or {}
    # Summary carries counts only; LLM prompt enhancement can read D1 directly if needed.
    # Keep minimal for now to avoid extra D1 roundtrip in hot path.

    canonical_candidate_payloads = build_canonical_candidate_payloads(candidates)

    try:
        reasons = await generate_recommendation_reasons_from_payloads(
            canonical_candidate_payloads,
            top_themes=top_themes,
        )
        breeze2_shadow = {}
        if _breeze2_reason_shadow_enabled():
            provider = _breeze2_reason_shadow_provider()
            if provider == "modal_generation":
                try:
                    timeout_s = _breeze2_reason_generation_timeout_seconds()
                    breeze2_shadow = await asyncio.wait_for(
                        build_breeze2_generation_shadow_for_canonical_payloads(
                            canonical_candidate_payloads,
                            run_date=state.get("run_date"),
                        ),
                        timeout=timeout_s,
                    )
                except TimeoutError:
                    logger.warning(
                        "[Pipeline V2] Breeze2 modal generation timed out after %.1fs; fallback to context shadow",
                        _breeze2_reason_generation_timeout_seconds(),
                    )
                    breeze2_shadow = build_breeze2_reason_shadow_for_canonical_payloads(canonical_candidate_payloads)
                except Exception as shadow_error:  # noqa: BLE001 - shadow provider must not block D1 writes.
                    logger.warning("[Pipeline V2] Breeze2 modal generation failed; fallback to context shadow: %s", shadow_error)
                    breeze2_shadow = build_breeze2_reason_shadow_for_canonical_payloads(canonical_candidate_payloads)
            else:
                try:
                    breeze2_shadow = build_breeze2_reason_shadow_for_canonical_payloads(canonical_candidate_payloads)
                except Exception as shadow_error:  # noqa: BLE001 - shadow provider must not block D1 writes.
                    logger.warning("[Pipeline V2] Breeze2 context shadow skipped: %s", shadow_error)
        if breeze2_shadow:
            logger.info("[Pipeline V2] Breeze2 reason shadow generated: %s", breeze2_reason_shadow_metrics(breeze2_shadow))
        return {"llm_reasons": reasons, "breeze2_reason_shadow": breeze2_shadow}
    except Exception as e:
        logger.error(f"[Pipeline V2] LLM reasons failed: {e}")
        return {"llm_reasons": {}, "errors": [f"llm_reasons: {e}"]}


async def node_write_d1(state: PipelineStateV2) -> dict:
    """
    Write predictions + update recommendations + delete SELL-filtered + re-rank.
    All in D1 batch_execute for atomicity.
    """
    logger.info("[Pipeline V2] node_write_d1")
    run_date = state["run_date"]

    # 1. Predictions
    stock_id_map = {s["symbol"]: s["id"] for s in state["active_stocks"]}
    stale_predictions_deleted = prune_predictions_outside_universe(list(stock_id_map.values()), run_date)
    predictions_written = write_predictions_to_d1(state["predictions"], stock_id_map, run_date)
    layer2_audit_rows = write_layer2_core_gate_audit(
        predictions=state["predictions"],
        screener_recs=state.get("screener_recs") or [],
        run_date=run_date,
        screener_run_id=state.get("screener_run_id"),
        target_size=(
            state.get("l2_core_ml_evidence_summary")
            or state.get("l2_core_ml_gate_summary")
            or {}
        ).get("target_size"),
    )
    layer3_audit_rows = write_layer3_formal_gate_audit(
        predictions=state["predictions"],
        recommendations=state.get("final_recommendations") or [],
        layer2_symbols=state.get("layer2_recommendation_symbols") or [],
        run_date=run_date,
        screener_run_id=state.get("screener_run_id"),
        target_size=state.get("layer3_formal_gate_target_size"),
    )

    # 2. Merge LLM reasons into recommendations (overwrite template)
    final = state["final_recommendations"]
    merge_llm_reasons_into_recommendations(final, state.get("llm_reasons") or {})
    merge_breeze2_reason_shadow_into_score_components(final, state.get("breeze2_reason_shadow") or {})

    # 3. Update daily_recommendations
    rec_updated = update_recommendations_in_d1(final, run_date)

    # 4. Preserve screener seed rows while marking SELL/NO_SIGNAL outputs as non-buy.
    sell_marked_non_buy = delete_filtered_recommendations(state.get("sell_filtered_symbols") or [], run_date)

    # 5. Re-rank
    re_rank_recommendations(run_date)
    alpha_bucket_counts: dict[str, int] = {}
    alpha_selected_bucket_counts: dict[str, int] = {}
    alpha_skip_count = 0
    for row in final:
        ctx = row.get("alpha_context") or {}
        bucket = ctx.get("edge_bucket")
        if bucket:
            alpha_bucket_counts[bucket] = alpha_bucket_counts.get(bucket, 0) + 1
        allocation = row.get("alpha_allocation") or {}
        allocation_bucket = allocation.get("bucket")
        if allocation.get("selected") and allocation_bucket:
            alpha_selected_bucket_counts[allocation_bucket] = alpha_selected_bucket_counts.get(allocation_bucket, 0) + 1
        if (ctx.get("risk_overlay") or {}).get("skip"):
            alpha_skip_count += 1

    dispersion = state.get("prediction_dispersion") or {}
    prediction_output_models = int(dispersion.get("n_models_seen") or 0) if isinstance(dispersion, dict) else 0
    if prediction_output_models <= 0:
        model_names: set[str] = set()
        for pred in (state.get("predictions") or {}).values():
            if not isinstance(pred, dict) or pred.get("error"):
                continue
            rank_scores = pred.get("rank_scores") or {}
            if isinstance(rank_scores, dict):
                model_names.update(str(name) for name in rank_scores if str(name))
            for src_key, model_name in (
                ("dlinear", "DLinear"),
                ("patchtst", "PatchTST"),
                ("itransformer", "iTransformer"),
                ("timesfm", "TimesFM"),
            ):
                if isinstance(pred.get(src_key), dict):
                    model_names.add(model_name)
        prediction_output_models = len(model_names)
    prediction_rows_per_symbol = (
        round(predictions_written / len(stock_id_map), 3) if stock_id_map else 0
    )

    metrics = {
        "predictions_written": predictions_written,
        "layer2_core_gate_audit_rows": layer2_audit_rows,
        "layer3_formal_gate_audit_rows": layer3_audit_rows,
        "prediction_symbols": len(stock_id_map),
        "prediction_output_models": prediction_output_models,
        "prediction_rows_per_symbol": prediction_rows_per_symbol,
        "stale_predictions_deleted": stale_predictions_deleted,
        "recommendations_updated": rec_updated,
        "sell_marked_non_buy": sell_marked_non_buy,
        "llm_reasons_count": len(state.get("llm_reasons") or {}),
        "breeze2_reason_shadow": breeze2_reason_shadow_metrics(state.get("breeze2_reason_shadow") or {}),
        "alpha_bucket_counts": alpha_bucket_counts,
        "alpha_selected_bucket_counts": alpha_selected_bucket_counts,
        "alpha_skip_count": alpha_skip_count,
    }
    if dispersion:
        metrics["prediction_dispersion"] = {
            key: value for key, value in dispersion.items()
            if key != "symbols"
        }
    if state.get("timesfm_l175_summary"):
        metrics["timesfm_l175_summary"] = state.get("timesfm_l175_summary")
    logger.info(f"[Pipeline V2] write_d1 done: {metrics}")
    return {"metrics": metrics}


# ?????????????????????????????????????????????????????????????????????????????
# Helpers
# ?????????????????????????????????????????????????????????????????????????????

def _snapshot_export_start_date(run_date: str) -> str:
    """Resolve the rolling research snapshot window from the pipeline run date."""
    try:
        lookback_days = int(os.getenv("STOCKVISION_RESEARCH_SNAPSHOT_LOOKBACK_DAYS", "504") or "504")
    except ValueError:
        lookback_days = 504
    lookback_days = max(30, min(lookback_days, 1600))
    return (datetime.strptime(run_date, "%Y-%m-%d") - timedelta(days=lookback_days)).strftime("%Y-%m-%d")


async def node_export_dataset_snapshot(state: PipelineStateV2) -> dict:
    """Export the post-recommendation research snapshot after serving D1 is written."""
    logger.info("[Pipeline V2] node_export_dataset_snapshot")
    metrics = dict(state.get("metrics") or {})
    run_date = state["run_date"]
    producer_run_id = state.get("producer_run_id") or f"pipeline-v2:{run_date}"

    if os.getenv("STOCKVISION_EXPORT_RESEARCH_SNAPSHOT", "1").strip().lower() in {"0", "false", "no", "off"}:
        metrics["dataset_snapshot_export"] = {
            "status": "skipped",
            "reason": "STOCKVISION_EXPORT_RESEARCH_SNAPSHOT disabled",
        }
        return {"metrics": metrics}

    mode = os.getenv("STOCKVISION_RESEARCH_SNAPSHOT_MODE", "deferred").strip().lower()
    if mode not in {"blocking", "sync", "synchronous"}:
        metrics["dataset_snapshot_export"] = {
            "status": "deferred",
            "mode": mode or "deferred",
            "reason": "daily serving pipeline must not block on research/backtest snapshot export",
            "producer_run_id": producer_run_id,
        }
        return {"metrics": metrics}

    try:
        from services.dataset_snapshot_exporter import (
            DatasetSnapshotExportRequest,
            export_daily_research_snapshots,
        )

        request = DatasetSnapshotExportRequest(
            business_date=run_date,
            start_date=_snapshot_export_start_date(run_date),
            end_date=run_date,
            producer_run_id=producer_run_id,
            include_signals=True,
        )
        combined = await asyncio.to_thread(export_daily_research_snapshots, request)
        backtest_summary = (combined.get("snapshots") or {}).get("backtest_dataset") or {}
        price_summary = (combined.get("snapshots") or {}).get("price_history") or {}
        backtest_snapshot = backtest_summary.get("snapshot") or {}
        price_snapshot = price_summary.get("snapshot") or {}
        metrics["dataset_snapshot_export"] = {
            "status": "ready",
            "snapshots": {
                "backtest_dataset": {
                    "snapshot_id": backtest_snapshot.get("snapshot_id"),
                    "row_count": backtest_snapshot.get("row_count"),
                    "elapsed_s": backtest_summary.get("elapsed_s"),
                    "d1_query_counts": backtest_summary.get("d1_query_counts"),
                },
                "price_history": {
                    "snapshot_id": price_snapshot.get("snapshot_id"),
                    "row_count": price_snapshot.get("row_count"),
                    "elapsed_s": price_summary.get("elapsed_s"),
                    "d1_query_counts": price_summary.get("d1_query_counts"),
                },
            },
        }
        logger.info(
            "[Pipeline V2] dataset snapshots exported: backtest=%s price_history=%s",
            backtest_snapshot.get("snapshot_id"),
            price_snapshot.get("snapshot_id"),
        )
        return {"metrics": metrics}
    except Exception as e:  # noqa: BLE001
        metrics["dataset_snapshot_export"] = {
            "status": "error",
            "error": f"{type(e).__name__}: {e}",
        }
        logger.exception("[Pipeline V2] dataset snapshot export failed")
        return {
            "metrics": metrics,
            "errors": [f"dataset_snapshot_export: {type(e).__name__}: {e}"],
        }


def _to_dict(obj: Any) -> dict:
    """Convert dataclass or dict to plain dict (for state serialization)."""
    if isinstance(obj, dict):
        return obj
    if hasattr(obj, "__dataclass_fields__"):
        from dataclasses import asdict
        return asdict(obj)
    return dict(obj) if obj else {}


# ?????????????????????????????????????????????????????????????????????????????
# Build graph
# ?????????????????????????????????????????????????????????????????????????????

_graph_singleton: Any = None


def build_graph():
    """Build and compile the LangGraph StateGraph."""
    g = StateGraph(PipelineStateV2)

    # 2026-04-08 P2: Retry policy for ml_predict ??protects against transient
    # Modal infra failures (grpc disconnect, control plane hiccup). Per-task
    # timeouts are already caught per-item by P1 return_exceptions, so retry
    # only fires when batch_predict itself raises (rare).
    ml_retry = RetryPolicy(
        max_attempts=2,
        initial_interval=2.0,
        backoff_factor=2.0,
        jitter=True,
    )

    g.add_node("load_inputs",       node_load_inputs)
    g.add_node("load_market_env",   node_load_market_env)
    g.add_node("compute_sector_flow", node_compute_sector_flow)
    g.add_node("build_payloads",    node_build_payloads)
    g.add_node("timesfm_l175_enrich", node_timesfm_l175_enrich, retry=ml_retry)
    g.add_node("ml_predict",        node_ml_predict, retry=ml_retry)
    g.add_node("l2_cheap_ml_predict", node_l2_cheap_ml_predict, retry=ml_retry)
    g.add_node("l2_core_gate",      node_l2_core_gate)
    g.add_node("l3_formal_predict", node_l3_formal_predict, retry=ml_retry)
    g.add_node("compute_personas", node_compute_personas)
    g.add_node("recommend",         node_recommend)
    g.add_node("gen_llm_reasons",   node_llm_reasons)
    g.add_node("write_d1",          node_write_d1)
    g.add_node("export_dataset_snapshot", node_export_dataset_snapshot)

    # Keep D1-heavy sector_flow out of the hot-path fan-out. The 22:00 chain
    # already runs indicator + screener writes, and parallel D1 readers can trip
    # Cloudflare D1 queued-too-long 429s.
    g.set_entry_point("load_inputs")
    g.add_edge("load_inputs",         "load_market_env")
    g.add_edge("load_market_env",     "build_payloads")
    if _l2_l3_split_enabled():
        g.add_edge("build_payloads",      "timesfm_l175_enrich")
        g.add_edge("timesfm_l175_enrich", "l2_cheap_ml_predict")
        g.add_edge("l2_cheap_ml_predict", "l2_core_gate")
        g.add_edge("l2_core_gate",        "l3_formal_predict")
        g.add_edge("l3_formal_predict",   "compute_personas")
    else:
        g.add_edge("build_payloads",      "ml_predict")
        g.add_edge("ml_predict",          "compute_personas")
    g.add_edge("compute_personas",    "recommend")
    g.add_edge("recommend",           "gen_llm_reasons")
    g.add_edge("gen_llm_reasons",     "write_d1")
    g.add_edge("write_d1",            "compute_sector_flow")
    g.add_edge("compute_sector_flow", "export_dataset_snapshot")
    g.add_edge("export_dataset_snapshot", END)

    # Checkpointer disabled for now:
    # - Local sqlite checkpointing is not durable in Cloud Run /tmp.
    # - langgraph-checkpoint-sqlite is intentionally not installed; adding it
    #   back would reintroduce an unused dependency owner and leave OSV debt.
    # - Cloud Run /tmp is ephemeral so checkpoint loses across restarts anyway
    # Phase 2 future: D1-backed AsyncSqliteSaver subclass for true resume support
    compiled = g.compile()
    logger.info("[Pipeline V2] Compiled without checkpointer (Cloud Run ephemeral /tmp)")
    return compiled


def get_graph():
    """Lazy singleton ??build once per Cloud Run container."""
    global _graph_singleton
    if _graph_singleton is None:
        _graph_singleton = build_graph()
    return _graph_singleton


# ?????????????????????????????????????????????????????????????????????????????
# Public runner
# ?????????????????????????????????????????????????????????????????????????????

async def run_pipeline_v2(run_date: str = "", producer_run_id: str = "") -> dict:
    """
    Execute the full pipeline V2.

    Args:
        run_date: TW date YYYY-MM-DD (default: today TW)

    Returns:
        {status, run_date, metrics, errors}
    """
    if not run_date:
        from datetime import datetime, timezone, timedelta
        tw_now = datetime.now(timezone.utc) + timedelta(hours=8)
        run_date = tw_now.strftime("%Y-%m-%d")

    initial_state: PipelineStateV2 = {
        "run_date": run_date,
        "producer_run_id": producer_run_id or f"pipeline-v2:{run_date}",
        "errors": [],
        "metrics": {},
    }

    logger.info(f"[Pipeline V2] Starting for {run_date}")
    t0 = asyncio.get_event_loop().time()

    graph = get_graph()
    try:
        # No checkpointer ??no config needed
        final_state = await graph.ainvoke(initial_state)
        elapsed = asyncio.get_event_loop().time() - t0
        logger.info(f"[Pipeline V2] Completed in {elapsed:.1f}s: {final_state.get('metrics', {})}")
        return {
            "status": "completed",
            "run_date": run_date,
            "elapsed_s": round(elapsed, 1),
            "metrics": final_state.get("metrics", {}),
            "errors": final_state.get("errors", []),
        }
    except Exception as e:
        elapsed = asyncio.get_event_loop().time() - t0
        logger.exception(f"[Pipeline V2] Failed after {elapsed:.1f}s")
        return {
            "status": "error",
            "run_date": run_date,
            "elapsed_s": round(elapsed, 1),
            "error": str(e),
        }
