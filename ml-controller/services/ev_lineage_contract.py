"""Point-in-time lineage contract for ScoreV2/Ensemble EV training features."""
from __future__ import annotations

import hashlib
import json
import math
from datetime import date, datetime, timedelta, timezone
from typing import Any, Callable

from services.active_model_policy import ACTIVE_ALPHA_MODELS


SCORE_FEATURE_VERSION = "score_v2"
SCORE_SEMANTIC_VERSION = "score-v2-active8-components-v3"
ENSEMBLE_SEMANTIC_VERSION = "active8-ic-weighted-rank-v4"
OOF_ENSEMBLE_SEMANTIC_VERSION = "active8-purged-oof-chronological-ridge-v3"
RECONSTRUCTION_VERSION = "ev-point-in-time-lineage-reconstruction-v1"
CHAMPION_HISTORY_SOURCE = "model_champion_history"
ROW_MODEL_VERSION_SOURCE = "predictions.model_signal"
ARTIFACT_REGISTRY_SOURCE = "model_artifact_registry"
ACTIVE_ALPHA_MODEL_SET = frozenset(ACTIVE_ALPHA_MODELS)
TAIPEI_UTC_OFFSET = timedelta(hours=8)
MAX_SAME_RUN_VERSION_EVIDENCE_AGE = timedelta(hours=12)
CANONICAL_SCORE_WEIGHTS = {
    "mlEdge": 25.0,
    "chipFlow": 25.0,
    "technicalStructure": 25.0,
    "fundamentalQuality": 25.0,
    "newsTheme": 0.0,
}
EV_SCORE_COMPONENTS = (
    "mlEdge",
    "chipFlow",
    "technicalStructure",
    "fundamentalQuality",
)
UNKNOWN_VERSION_TOKENS = {"", "unknown", "none", "null", "n/a", "na", "missing", "unversioned"}


def _loads(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return dict(value)
    if not isinstance(value, str) or not value.strip():
        return {}
    try:
        parsed = json.loads(value)
    except json.JSONDecodeError:
        return {}
    return parsed if isinstance(parsed, dict) else {}


def _finite(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def _iso(value: Any) -> datetime | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def _round1(value: float) -> float:
    return math.floor(float(value) * 10.0 + 0.5) / 10.0


def _stable_hash(payload: Any) -> str:
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def is_known_artifact_version(value: Any) -> bool:
    return str(value or "").strip().lower() not in UNKNOWN_VERSION_TOKENS


def _is_sha256_checksum(value: Any) -> bool:
    text = str(value or "").strip().lower()
    digest = text.removeprefix("sha256:")
    return text.startswith("sha256:") and len(digest) == 64 and all(char in "0123456789abcdef" for char in digest)


def build_model_set_signature(artifact_versions: dict[str, Any], contributing_models: list[str]) -> str | None:
    names = sorted({str(name).strip() for name in contributing_models if str(name).strip()})
    if not names:
        return None
    normalized = {name: str(artifact_versions.get(name) or "").strip() for name in names}
    if any(not is_known_artifact_version(version) for version in normalized.values()):
        return None
    return "|".join(f"{name}@{normalized[name]}" for name in names)


def parse_model_set_signature(value: Any) -> dict[str, str] | None:
    text = str(value or "").strip()
    if not text:
        return None
    parsed: dict[str, str] = {}
    for part in text.split("|"):
        if part.count("@") != 1:
            return None
        model_name, version = (piece.strip() for piece in part.split("@", 1))
        if not model_name or not is_known_artifact_version(version) or model_name in parsed:
            return None
        parsed[model_name] = version
    return parsed or None


def ensemble_lineage_blockers(payload: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    generation_mode = str(payload.get("generation_mode") or "native").strip().lower()
    expected_semantic = (
        OOF_ENSEMBLE_SEMANTIC_VERSION
        if generation_mode == "purged_oof"
        else ENSEMBLE_SEMANTIC_VERSION
    )
    if str(payload.get("semantic_version") or "").strip() != expected_semantic:
        blockers.append("ensemble_semantic_version_incompatible")
    versions = payload.get("artifact_versions") if isinstance(payload.get("artifact_versions"), dict) else {}
    contributors = payload.get("contributing_models") if isinstance(payload.get("contributing_models"), list) else []
    contributors = sorted({str(name).strip() for name in contributors if str(name).strip()})
    if not contributors:
        signature_models = parse_model_set_signature(payload.get("model_set_signature"))
        contributors = sorted(signature_models or {})
    if not contributors:
        blockers.append("contributing_models_missing")
    blockers.extend(
        f"contributor_not_active8:{name}"
        for name in contributors
        if name not in ACTIVE_ALPHA_MODEL_SET
    )
    missing_versions = [name for name in contributors if not is_known_artifact_version(versions.get(name))]
    blockers.extend(f"artifact_version_missing:{name}" for name in missing_versions)
    expected_signature = build_model_set_signature(versions, contributors)
    actual_signature = str(payload.get("model_set_signature") or "").strip()
    if expected_signature is None:
        blockers.append("model_set_signature_unresolvable")
    elif actual_signature != expected_signature:
        blockers.append("model_set_signature_mismatch")
    if parse_model_set_signature(actual_signature) is None:
        blockers.append("model_set_signature_invalid")
    return list(dict.fromkeys(blockers))


def score_lineage_blockers(payload: dict[str, Any]) -> list[str]:
    blockers: list[str] = []
    if str(payload.get("version") or "").strip().lower() != SCORE_FEATURE_VERSION:
        blockers.append("score_feature_version_incompatible")
    if str(payload.get("semanticVersion") or "").strip() != SCORE_SEMANTIC_VERSION:
        blockers.append("score_semantic_version_incompatible")
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    for name in EV_SCORE_COMPONENTS:
        maximum = CANONICAL_SCORE_WEIGHTS[name]
        value = _finite(components.get(name))
        if value is None or value < 0.0 or value > maximum:
            blockers.append(f"score_component_invalid:{name}")
    return blockers


def ev_feature_lineage_blockers(row: dict[str, Any]) -> list[str]:
    score_payload = _loads(row.get("score_components"))
    forecast_payload = _loads(row.get("forecast_data"))
    ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
    return list(dict.fromkeys([
        *score_lineage_blockers(score_payload),
        *ensemble_lineage_blockers(ensemble_payload),
    ]))


def canonical_ev_feature_values(row: dict[str, Any]) -> dict[str, float] | None:
    if ev_feature_lineage_blockers(row):
        return None
    score_payload = _loads(row.get("score_components"))
    components = score_payload.get("components") if isinstance(score_payload.get("components"), dict) else {}
    forecast_payload = _loads(row.get("forecast_data"))
    ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
    avg_rank = _finite(ensemble_payload.get("avg_rank"))
    if avg_rank is None:
        return None
    return {
        "ml_edge_norm": float(components["mlEdge"]) / 25.0,
        "fundamental_quality_norm": float(components["fundamentalQuality"]) / 25.0,
        "chip_flow_norm": float(components["chipFlow"]) / 25.0,
        "technical_structure_norm": float(components["technicalStructure"]) / 25.0,
        "ensemble_directional_margin": avg_rank - 0.5,
    }


def _contributing_models(payload: dict[str, Any]) -> list[str]:
    explicit = payload.get("contributing_models") if isinstance(payload.get("contributing_models"), list) else []
    names = {str(name).strip() for name in explicit if str(name).strip()}
    weights = payload.get("weights") if isinstance(payload.get("weights"), dict) else {}
    for name, weight in weights.items():
        number = _finite(weight)
        if number is not None and number > 0:
            names.add(str(name).strip())
    signature = parse_model_set_signature(payload.get("model_set_signature")) or {}
    names.update(signature)
    return sorted(name for name in names if name)


def prediction_timing_blockers(row: dict[str, Any]) -> list[str]:
    """Reject delayed historical reruns that were unavailable at the next open.

    Same-day production rows are always earlier than any future executable
    session. Delayed rows require the next actual price session so exchange
    holidays and emergency closures are handled without a calendar guess.
    """

    generated_at = _iso(row.get("prediction_generated_at") or row.get("generated_at"))
    if generated_at is None:
        return ["prediction_generated_at_missing_or_invalid"]
    signal_text = str(
        row.get("prediction_date")
        or row.get("recommendation_date")
        or row.get("date")
        or ""
    )[:10]
    try:
        signal_date = date.fromisoformat(signal_text)
    except ValueError:
        return ["prediction_signal_date_missing_or_invalid"]
    generated_taipei_date = (generated_at + TAIPEI_UTC_OFFSET).date()
    if generated_taipei_date <= signal_date:
        return []
    next_session_open = _iso(row.get("next_session_open_at"))
    if next_session_open is None:
        return ["next_session_open_missing_for_delayed_prediction"]
    if generated_at >= next_session_open:
        return ["prediction_generated_at_not_before_next_session_open"]
    return []


def _row_model_version(
    evidence_payload: dict[str, Any],
    *,
    model_name: str,
    prediction_generated_at: datetime,
    signal_date: str,
) -> tuple[str | None, str | None]:
    raw = evidence_payload.get(model_name)
    if raw is None:
        return None, None
    if not isinstance(raw, dict):
        return None, f"row_model_version_evidence_invalid:{model_name}"
    if str(raw.get("source") or "").strip() != ROW_MODEL_VERSION_SOURCE:
        return None, f"row_model_version_source_invalid:{model_name}"
    if str(raw.get("prediction_date") or "")[:10] != signal_date:
        return None, f"row_model_version_prediction_date_mismatch:{model_name}"
    evidence_generated_at = _iso(raw.get("generated_at"))
    if evidence_generated_at is None or evidence_generated_at > prediction_generated_at:
        return None, f"row_model_version_time_invalid:{model_name}"
    if prediction_generated_at - evidence_generated_at > MAX_SAME_RUN_VERSION_EVIDENCE_AGE:
        return None, f"row_model_version_not_same_run:{model_name}"
    version = str(raw.get("version") or "").strip()
    if not is_known_artifact_version(version):
        return None, f"row_model_version_unknown:{model_name}"
    registry = raw.get("artifact_registry")
    if not isinstance(registry, dict):
        return None, f"row_model_version_registry_missing:{model_name}"
    if str(registry.get("source") or "").strip() != ARTIFACT_REGISTRY_SOURCE:
        return None, f"row_model_version_registry_source_invalid:{model_name}"
    if str(registry.get("model_name") or "").strip() != model_name:
        return None, f"row_model_version_registry_model_mismatch:{model_name}"
    if str(registry.get("version") or "").strip() != version:
        return None, f"row_model_version_registry_version_mismatch:{model_name}"
    if not str(registry.get("artifact_id") or "").strip() or not str(registry.get("artifact_path") or "").strip():
        return None, f"row_model_version_registry_artifact_missing:{model_name}"
    if not _is_sha256_checksum(registry.get("checksum")):
        return None, f"row_model_version_registry_checksum_invalid:{model_name}"
    registry_created_at = _iso(registry.get("created_at"))
    if registry_created_at is None or registry_created_at > evidence_generated_at:
        return None, f"row_model_version_registry_not_point_in_time:{model_name}"
    return version, None


def attach_same_run_model_version_evidence(
    query_fn: Callable[[str, list[Any] | None], list[dict[str, Any]]],
    rows: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    """Batch-load exact per-model versions without per-candidate SQL queries."""

    dates = sorted({
        str(row.get("prediction_date") or row.get("recommendation_date") or row.get("date") or "")[:10]
        for row in rows
        if str(row.get("prediction_date") or row.get("recommendation_date") or row.get("date") or "")[:10]
    })
    evidence_by_key: dict[tuple[str, str, str], list[dict[str, Any]]] = {}
    loaded_rows = 0
    for signal_date in dates:
        next_date = (date.fromisoformat(signal_date) + timedelta(days=1)).isoformat()
        evidence_rows = query_fn(
            """
            SELECT stock_id,
                   prediction_date,
                   model_name,
                   generated_at,
                   json_extract(forecast_data, '$.model_signal.model_version') AS model_version
              FROM predictions
             WHERE prediction_date >= ?
               AND prediction_date < ?
               AND model_name IN (
                   'LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN',
                   'DLinear', 'PatchTST', 'iTransformer'
               )
               AND json_extract(forecast_data, '$.model_signal.model_version') IS NOT NULL
             ORDER BY stock_id, model_name, datetime(generated_at) ASC, id ASC
            """,
            [signal_date, next_date],
        )
        loaded_rows += len(evidence_rows or [])
        for evidence in evidence_rows or []:
            key = (
                str(evidence.get("stock_id") or ""),
                str(evidence.get("prediction_date") or "")[:10],
                str(evidence.get("model_name") or "").strip(),
            )
            evidence_by_key.setdefault(key, []).append(evidence)

    registry_rows = query_fn(
        """
        SELECT artifact_id, model_name, version, artifact_path, metadata_path,
               checksum, created_at
          FROM model_artifact_registry
         WHERE model_name IN (
             'LightGBM', 'XGBoost', 'ExtraTrees', 'TabM', 'GNN',
             'DLinear', 'PatchTST', 'iTransformer'
         )
           AND artifact_path IS NOT NULL
           AND trim(artifact_path) <> ''
         ORDER BY model_name, version, datetime(created_at) ASC
        """,
        [],
    ) if rows else []
    registry_by_key: dict[tuple[str, str], list[tuple[datetime, dict[str, Any]]]] = {}
    for registry_row in registry_rows or []:
        registry_created_at = _iso(registry_row.get("created_at"))
        model_name = str(registry_row.get("model_name") or "").strip()
        version = str(registry_row.get("version") or "").strip()
        if registry_created_at is None or not model_name or not is_known_artifact_version(version):
            continue
        registry_by_key.setdefault((model_name, version), []).append((registry_created_at, registry_row))

    enriched: list[dict[str, Any]] = []
    matched_versions = 0
    for row in rows:
        candidate = dict(row)
        point_in_time = _iso(candidate.get("prediction_generated_at") or candidate.get("generated_at"))
        signal_date = str(
            candidate.get("prediction_date")
            or candidate.get("recommendation_date")
            or candidate.get("date")
            or ""
        )[:10]
        stock_id = str(candidate.get("stock_id") or "")
        evidence_payload: dict[str, Any] = {}
        if point_in_time is not None and stock_id and signal_date:
            for model_name in ACTIVE_ALPHA_MODELS:
                candidates = evidence_by_key.get((stock_id, signal_date, model_name), [])
                eligible = []
                for evidence in candidates:
                    evidence_at = _iso(evidence.get("generated_at"))
                    if evidence_at is None or evidence_at > point_in_time:
                        continue
                    if point_in_time - evidence_at > MAX_SAME_RUN_VERSION_EVIDENCE_AGE:
                        continue
                    eligible.append((evidence_at, evidence))
                if not eligible:
                    continue
                eligible.sort(key=lambda item: item[0], reverse=True)
                selected = eligible[0][1]
                selected_version = str(selected.get("model_version") or "").strip()
                selected_generated_at = _iso(selected.get("generated_at"))
                registry_candidates = [
                    item
                    for item in registry_by_key.get((model_name, selected_version), [])
                    if selected_generated_at is not None and item[0] <= selected_generated_at
                ]
                registry_candidates.sort(key=lambda item: item[0], reverse=True)
                registry = registry_candidates[0][1] if registry_candidates else None
                evidence_payload[model_name] = {
                    "version": selected_version,
                    "generated_at": selected.get("generated_at"),
                    "prediction_date": signal_date,
                    "source": ROW_MODEL_VERSION_SOURCE,
                    "artifact_registry": {
                        "artifact_id": registry.get("artifact_id"),
                        "model_name": registry.get("model_name"),
                        "version": registry.get("version"),
                        "artifact_path": registry.get("artifact_path"),
                        "metadata_path": registry.get("metadata_path"),
                        "checksum": registry.get("checksum"),
                        "created_at": registry.get("created_at"),
                        "source": ARTIFACT_REGISTRY_SOURCE,
                    } if registry else None,
                }
                matched_versions += 1
        candidate["row_model_version_evidence"] = evidence_payload
        enriched.append(candidate)
    return enriched, {
        "schema_version": "same-run-model-version-evidence-audit-v1",
        "signal_dates": dates,
        "query_count": len(dates) + (1 if rows else 0),
        "evidence_rows_loaded": loaded_rows,
        "artifact_registry_rows_loaded": len(registry_rows or []),
        "candidate_rows": len(rows),
        "matched_versions": matched_versions,
        "registry_verified_versions": sum(
            1
            for row in enriched
            for evidence in (row.get("row_model_version_evidence") or {}).values()
            if isinstance(evidence, dict) and isinstance(evidence.get("artifact_registry"), dict)
        ),
    }


def attach_next_session_open_evidence(
    query_fn: Callable[[str, list[Any] | None], list[dict[str, Any]]],
    rows: list[dict[str, Any]],
    supplied_next_session_dates: dict[str, str] | None = None,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    delayed_dates: set[str] = set()
    for row in rows:
        signal_text = str(
            row.get("prediction_date")
            or row.get("recommendation_date")
            or row.get("date")
            or ""
        )[:10]
        generated_at = _iso(row.get("prediction_generated_at") or row.get("generated_at"))
        try:
            signal_date = date.fromisoformat(signal_text)
        except ValueError:
            continue
        if generated_at is not None and (generated_at + TAIPEI_UTC_OFFSET).date() > signal_date:
            delayed_dates.add(signal_text)

    supplied = {
        str(signal_date)[:10]: str(next_date)[:10]
        for signal_date, next_date in (supplied_next_session_dates or {}).items()
        if str(signal_date)[:10] in delayed_dates
        and str(next_date)[:10] > str(signal_date)[:10]
    }
    next_dates: dict[str, str] = dict(supplied)
    unresolved_dates = delayed_dates - set(next_dates)
    if unresolved_dates:
        ordered_dates = sorted(unresolved_dates)
        values_sql = ", ".join("(?)" for _ in ordered_dates)
        session_rows = query_fn(
            f"""
            WITH signal_dates(signal_date) AS (VALUES {values_sql})
            SELECT signal_date,
                   (
                     SELECT MIN(c.date)
                       FROM canonical_market_daily c
                      WHERE c.stock_id = '0050'
                        AND c.source = 'finlab.price'
                        AND date(c.date) > date(signal_dates.signal_date)
                   ) AS next_session_date
              FROM signal_dates
            ORDER BY signal_date
            """,
            ordered_dates,
        )
        next_dates.update({
            str(item.get("signal_date") or "")[:10]: str(item.get("next_session_date") or "")[:10]
            for item in session_rows or []
            if item.get("next_session_date")
        })

    enriched: list[dict[str, Any]] = []
    for row in rows:
        candidate = dict(row)
        signal_text = str(
            candidate.get("prediction_date")
            or candidate.get("recommendation_date")
            or candidate.get("date")
            or ""
        )[:10]
        next_date = next_dates.get(signal_text)
        if next_date:
            candidate["next_session_open_at"] = f"{next_date}T01:00:00Z"
        enriched.append(candidate)
    return enriched, {
        "schema_version": "next-session-open-evidence-audit-v1",
        "source": (
            "worker_twse_calendar+canonical_market_daily:0050:finlab.price"
            if supplied else "canonical_market_daily:0050:finlab.price"
        ),
        "calendar_supplied_signal_dates": sorted(supplied),
        "delayed_signal_dates": sorted(delayed_dates),
        "resolved_signal_dates": sorted(next_dates),
        "unresolved_signal_dates": sorted(delayed_dates - set(next_dates)),
    }


def resolve_artifact_versions_as_of(
    events: list[dict[str, Any]],
    *,
    contributing_models: list[str],
    generated_at: str,
    signal_date: str,
    row_model_version_evidence: dict[str, Any] | None = None,
) -> tuple[dict[str, str], dict[str, str], list[str], list[str]]:
    point_in_time = _iso(generated_at)
    if point_in_time is None:
        return {}, {}, ["prediction_generated_at_missing_or_invalid"], []
    versions: dict[str, str] = {}
    version_sources: dict[str, str] = {}
    blockers: list[str] = []
    warnings: list[str] = []
    evidence_payload = row_model_version_evidence or {}
    for model_name in sorted(set(contributing_models)):
        candidates: list[tuple[datetime, dict[str, Any]]] = []
        for event in events:
            if str(event.get("model_name") or "").strip() != model_name:
                continue
            effective_at = _iso(event.get("effective_at"))
            retired_at = _iso(event.get("retired_at"))
            if effective_at is None or effective_at > point_in_time:
                continue
            if retired_at is not None and point_in_time >= retired_at:
                continue
            if str(event.get("evidence_grade") or "").strip() != "exact":
                continue
            if str(event.get("source") or "").strip() != CHAMPION_HISTORY_SOURCE:
                continue
            if not is_known_artifact_version(event.get("version")):
                continue
            candidates.append((effective_at, event))
        champion_version: str | None = None
        if candidates:
            candidates.sort(key=lambda item: item[0], reverse=True)
            latest_at = candidates[0][0]
            latest_versions = {
                str(event.get("version") or "").strip()
                for effective_at, event in candidates
                if effective_at == latest_at
            }
            if len(latest_versions) != 1:
                blockers.append(f"point_in_time_champion_ambiguous:{model_name}")
                continue
            champion_version = next(iter(latest_versions))

        row_version, row_blocker = _row_model_version(
            evidence_payload,
            model_name=model_name,
            prediction_generated_at=point_in_time,
            signal_date=signal_date,
        )
        if row_blocker:
            blockers.append(row_blocker)
            continue
        if row_version:
            versions[model_name] = row_version
            version_sources[model_name] = ROW_MODEL_VERSION_SOURCE
            if champion_version and row_version != champion_version:
                warnings.append(f"champion_history_mismatch:{model_name}")
        elif champion_version:
            versions[model_name] = champion_version
            version_sources[model_name] = CHAMPION_HISTORY_SOURCE
        else:
            blockers.append(f"point_in_time_artifact_version_missing:{model_name}")
    return versions, version_sources, blockers, warnings


def _rebuild_score_payload(payload: dict[str, Any]) -> tuple[dict[str, Any] | None, list[str]]:
    components = payload.get("components") if isinstance(payload.get("components"), dict) else {}
    rebuilt_components: dict[str, float] = {}
    blockers: list[str] = []
    for name in EV_SCORE_COMPONENTS:
        maximum = CANONICAL_SCORE_WEIGHTS[name]
        value = _finite(components.get(name))
        if value is None or value < 0.0 or value > maximum:
            blockers.append(f"score_component_invalid:{name}")
        else:
            rebuilt_components[name] = _round1(value)
    if blockers:
        return None, blockers
    news_theme = _finite(components.get("newsTheme"))
    rebuilt_components["newsTheme"] = _round1(news_theme) if news_theme is not None else 0.0
    total = _round1(sum(rebuilt_components.values()))
    stored_final = _finite(payload.get("finalScore"))
    stored_total = _finite(payload.get("total"))
    alpha_adjustment = _finite(payload.get("alphaAdjustment"))
    if alpha_adjustment is None:
        alpha_adjustment = (stored_final - (stored_total if stored_total is not None else total)) if stored_final is not None else 0.0
    final_score = _round1(max(0.0, min(100.0, total + alpha_adjustment)))
    if stored_final is not None and abs(stored_final - final_score) > 0.11:
        return None, ["score_final_reconstruction_mismatch"]
    rebuilt = {
        **payload,
        "version": SCORE_FEATURE_VERSION,
        "semanticVersion": SCORE_SEMANTIC_VERSION,
        "weights": {name: int(value) for name, value in CANONICAL_SCORE_WEIGHTS.items()},
        "components": rebuilt_components,
        "total": total,
        "alphaAdjustment": _round1(alpha_adjustment),
        "finalScore": final_score,
    }
    return rebuilt, []


def reconstruct_point_in_time_ev_lineage(
    row: dict[str, Any],
    *,
    champion_events: list[dict[str, Any]],
) -> dict[str, Any]:
    timing_blockers = prediction_timing_blockers(row)
    if timing_blockers:
        return {
            "status": "rejected",
            "row": None,
            "blockers": timing_blockers,
            "audit": {
                "native_lineage": False,
                "counterfactual": False,
                "prediction_generated_at": row.get("prediction_generated_at") or row.get("generated_at"),
                "next_session_open_at": row.get("next_session_open_at"),
            },
        }
    generated_at = str(row.get("prediction_generated_at") or row.get("generated_at") or "").strip()
    score_payload = _loads(row.get("score_components"))
    forecast_payload = _loads(row.get("forecast_data"))
    ensemble_payload = forecast_payload.get("ensemble_v2") if isinstance(forecast_payload.get("ensemble_v2"), dict) else {}
    contributors = _contributing_models(ensemble_payload)
    signal_date = str(
        row.get("prediction_date")
        or row.get("recommendation_date")
        or row.get("date")
        or ""
    )[:10]
    row_model_version_evidence = _loads(row.get("row_model_version_evidence"))
    versions, version_sources, version_blockers, version_warnings = resolve_artifact_versions_as_of(
        champion_events,
        contributing_models=contributors,
        generated_at=generated_at,
        signal_date=signal_date,
        row_model_version_evidence=row_model_version_evidence,
    )

    native_blockers = ev_feature_lineage_blockers(row)
    if not native_blockers:
        native_versions = ensemble_payload.get("artifact_versions") if isinstance(ensemble_payload.get("artifact_versions"), dict) else {}
        provenance_blockers = list(version_blockers)
        for model_name in contributors:
            if str(native_versions.get(model_name) or "").strip() != str(versions.get(model_name) or "").strip():
                provenance_blockers.append(f"native_artifact_version_not_point_in_time:{model_name}")
        provenance_blockers = list(dict.fromkeys(provenance_blockers))
        if provenance_blockers:
            return {
                "status": "rejected",
                "row": None,
                "blockers": provenance_blockers,
                "audit": {
                    "native_lineage": True,
                    "prediction_generated_at": generated_at or None,
                    "next_session_open_at": row.get("next_session_open_at"),
                    "artifact_version_sources": version_sources,
                    "warnings": version_warnings,
                },
            }
        return {
            "status": "native",
            "row": dict(row),
            "blockers": [],
            "audit": {
                "native_lineage": True,
                "prediction_generated_at": generated_at or None,
                "next_session_open_at": row.get("next_session_open_at"),
                "artifact_version_sources": version_sources,
                "warnings": version_warnings,
                "as_of_guard": "prediction_generated_at<next_executable_session_open_when_delayed;exact_same_run_model_signal_plus_registry_or_point_in_time_champion",
            },
        }

    rebuilt_score, score_blockers = _rebuild_score_payload(score_payload)
    avg_rank = _finite(ensemble_payload.get("avg_rank"))
    blockers = list(score_blockers)
    if avg_rank is None or not 0.0 <= avg_rank <= 1.0:
        blockers.append("ensemble_avg_rank_missing_or_invalid")
    if not contributors:
        blockers.append("contributing_models_missing")
    blockers.extend(
        f"contributor_not_active8:{name}"
        for name in contributors
        if name not in ACTIVE_ALPHA_MODEL_SET
    )
    blockers.extend(version_blockers)
    signature = build_model_set_signature(versions, contributors)
    if signature is None:
        blockers.append("model_set_signature_unresolvable")
    blockers = list(dict.fromkeys(blockers))
    if blockers or rebuilt_score is None:
        return {
            "status": "rejected",
            "row": None,
            "blockers": blockers,
            "audit": {
                "native_lineage": False,
                "counterfactual": True,
                "reconstruction_version": RECONSTRUCTION_VERSION,
                "prediction_generated_at": generated_at or None,
            },
        }

    prevalidated_feature_values = {
        "ml_edge_norm": rebuilt_score["components"]["mlEdge"] / 25.0,
        "fundamental_quality_norm": rebuilt_score["components"]["fundamentalQuality"] / 25.0,
        "chip_flow_norm": rebuilt_score["components"]["chipFlow"] / 25.0,
        "technical_structure_norm": rebuilt_score["components"]["technicalStructure"] / 25.0,
        "ensemble_directional_margin": float(avg_rank) - 0.5,
    }
    reconstruction_evidence = {
        "native_lineage": False,
        "counterfactual": True,
        "reconstruction_version": RECONSTRUCTION_VERSION,
        "prediction_generated_at": generated_at,
        "next_session_open_at": row.get("next_session_open_at"),
        "artifact_version_sources": version_sources,
        "warnings": version_warnings,
        "as_of_guard": "prediction_generated_at<next_executable_session_open_when_delayed;exact_same_run_model_signal_plus_registry_or_point_in_time_champion",
        "feature_values": prevalidated_feature_values,
        "source_payload_hash": _stable_hash({"score_components": score_payload, "ensemble_v2": ensemble_payload}),
    }
    rebuilt_ensemble = {
        **ensemble_payload,
        "semantic_version": ENSEMBLE_SEMANTIC_VERSION,
        "artifact_versions": versions,
        "contributing_models": contributors,
        "model_set_signature": signature,
        "lineage_status": "point_in_time_reconstructed",
        "lineage_evidence": reconstruction_evidence,
    }
    rebuilt_forecast = {**forecast_payload, "ensemble_v2": rebuilt_ensemble}
    rebuilt_row = {
        **row,
        "score_components": json.dumps(rebuilt_score, ensure_ascii=False, separators=(",", ":")),
        "forecast_data": json.dumps(rebuilt_forecast, ensure_ascii=False, separators=(",", ":")),
        "ev_lineage_reconstruction": reconstruction_evidence,
    }
    final_blockers = ev_feature_lineage_blockers(rebuilt_row)
    if final_blockers:
        return {"status": "rejected", "row": None, "blockers": final_blockers, "audit": reconstruction_evidence}
    canonical_features = canonical_ev_feature_values(rebuilt_row)
    if canonical_features != prevalidated_feature_values:
        return {
            "status": "rejected",
            "row": None,
            "blockers": ["reconstructed_feature_parity_mismatch"],
            "audit": reconstruction_evidence,
        }
    return {"status": "reconstructed", "row": rebuilt_row, "blockers": [], "audit": reconstruction_evidence}


def reconstruct_rows_with_point_in_time_lineage(
    rows: list[dict[str, Any]],
    *,
    champion_events: list[dict[str, Any]],
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    accepted: list[dict[str, Any]] = []
    status_counts: dict[str, int] = {}
    blocker_counts: dict[str, int] = {}
    warning_counts: dict[str, int] = {}
    for row in rows:
        result = reconstruct_point_in_time_ev_lineage(row, champion_events=champion_events)
        status = str(result.get("status") or "rejected")
        status_counts[status] = status_counts.get(status, 0) + 1
        for blocker in result.get("blockers") or []:
            blocker_counts[str(blocker)] = blocker_counts.get(str(blocker), 0) + 1
        audit = result.get("audit") if isinstance(result.get("audit"), dict) else {}
        for warning in audit.get("warnings") or []:
            warning_counts[str(warning)] = warning_counts.get(str(warning), 0) + 1
        if isinstance(result.get("row"), dict):
            accepted.append(result["row"])
    return accepted, {
        "schema_version": "ev-lineage-reconstruction-audit-v1",
        "input_rows": len(rows),
        "accepted_rows": len(accepted),
        "status_counts": dict(sorted(status_counts.items())),
        "blocker_counts": dict(sorted(blocker_counts.items())),
        "warning_counts": dict(sorted(warning_counts.items())),
        "champion_event_count": len(champion_events),
    }


def load_model_champion_history(
    query_fn: Callable[[str, list[Any] | None], list[dict[str, Any]]],
    *,
    start_at: str,
    end_at: str,
) -> tuple[list[dict[str, Any]], dict[str, Any]]:
    try:
        rows = query_fn(
            """
            SELECT model_name, version, artifact_id, effective_at, retired_at,
                   source, evidence_grade, evidence_json
            FROM model_champion_history
            WHERE datetime(effective_at) <= datetime(?)
              AND (retired_at IS NULL OR datetime(retired_at) > datetime(?))
            ORDER BY model_name, datetime(effective_at) ASC
            """,
            [end_at, start_at],
        )
    except Exception as exc:  # noqa: BLE001 - migration availability is reported and fails closed.
        return [], {"status": "unavailable", "reason": str(exc), "rows": 0}
    return rows or [], {"status": "loaded", "reason": None, "rows": len(rows or [])}
