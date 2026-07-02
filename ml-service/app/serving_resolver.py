from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone
from typing import Any

DIRECT_ALPHA_MODELS = (
    "LightGBM",
    "XGBoost",
    "ExtraTrees",
    "TabM",
    "GNN",
    "DLinear",
    "PatchTST",
    "iTransformer",
)
L2_SIDECARS = ("TimesFM",)
SERVING_OK_STATES = {"production"}
SERVING_OK_OFFLINE_DECISIONS = {"STRONG_PASS", "PASS", "PRODUCTION_BACKFILL", "NOT_EVALUATED"}
SERVING_BAD_LIVE_STATUSES = {"failed", "rolling_ic_failed", "live_gate_failed"}
ARTIFACT_EXTENSIONS = {
    "LightGBM": "joblib",
    "XGBoost": "joblib",
    "ExtraTrees": "joblib",
    "TabM": "pt",
    "GNN": "pt",
    "DLinear": "pt",
    "PatchTST": "zip",
    "iTransformer": "zip",
    "TimesFM": "json",
}


def d1_champion_serving_enabled() -> bool:
    owner = str(os.environ.get("MODEL_SERVING_OWNER") or "d1_champion").strip().lower()
    return owner in {"d1", "d1_champion", "model_champion_pointers"}


def _d1_env_configured() -> bool:
    return all(str(os.environ.get(key) or "").strip() for key in ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"))


def _json_obj(value: Any) -> dict[str, Any]:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    return {}


def _folder(model_name: str) -> str:
    return model_name.lower().replace("-", "_")


def _default_artifact_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/{version}.{ARTIFACT_EXTENSIONS.get(model_name, 'joblib')}"


def _default_metadata_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/metadata_{version}.json"


def _artifact_block_reason(artifact: dict[str, Any] | None) -> str | None:
    if not artifact:
        return "missing_registry_artifact"
    state = str(artifact.get("state") or "").strip()
    if state not in SERVING_OK_STATES:
        return f"artifact_state_{state or 'missing'}"
    offline_decision = str(artifact.get("offline_gate_decision") or "").strip().upper()
    if offline_decision and offline_decision not in SERVING_OK_OFFLINE_DECISIONS:
        return f"offline_gate_{offline_decision.lower()}"
    live_status = str(artifact.get("live_gate_status") or "").strip().lower()
    if live_status in SERVING_BAD_LIVE_STATUSES:
        return f"live_gate_{live_status}"
    if not str(artifact.get("artifact_path") or "").strip():
        return "missing_artifact_path"
    return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        try:
            if value is not None:
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def _copy_ic_fields(entry: dict[str, Any], *, artifact: dict[str, Any] | None, pointer: dict[str, Any] | None, fallback: dict[str, Any]) -> None:
    live = _json_obj((artifact or {}).get("live_evidence_json"))
    offline = _json_obj((artifact or {}).get("offline_evidence_json"))
    promotion = _json_obj((pointer or {}).get("promotion_evidence_json"))
    sources = [promotion, live, offline, fallback]
    rolling_ic = _first_number(*(source.get("rolling_ic") for source in sources), *(source.get("live_ic") for source in sources))
    ic_4w = _first_number(*(source.get("ic_4w_avg") for source in sources), *(source.get("oos_ic") for source in sources))
    if rolling_ic is not None:
        entry["rolling_ic"] = rolling_ic
    if ic_4w is not None:
        entry["ic_4w_avg"] = ic_4w
    for key in ("weekly_ic", "last_ic_by_segment", "last_ic_status", "last_ic_root_cause", "last_ic_sample_count"):
        for source in sources:
            value = source.get(key)
            if value is not None:
                entry[key] = value
                break
    entry["serving_ic_source"] = "model_champion_pointers/model_artifact_registry"


def build_pool_from_champion_pointers(
    *,
    pointers: list[dict[str, Any]],
    artifacts: list[dict[str, Any]],
    fallback_pool: dict[str, Any] | None = None,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    pool = copy.deepcopy(fallback_pool or {})
    pool["schema_version"] = pool.get("schema_version") or "model_pool_v2"
    pool["last_updated"] = datetime.now(timezone.utc).isoformat()
    pool["source_of_truth"] = "model_champion_pointers"
    pool["compat_shape"] = "model_pool"
    pool["models"] = dict(pool.get("models") or {})
    pool["l2_feature_sidecars"] = dict(pool.get("l2_feature_sidecars") or {})
    pointer_by_model = {str(row.get("model_name")): row for row in pointers if row.get("model_name")}
    artifacts_by_id = {str(row.get("artifact_id")): row for row in artifacts if row.get("artifact_id")}
    artifacts_by_model_version: dict[tuple[str, str], list[dict[str, Any]]] = {}
    for row in artifacts:
        model_name = str(row.get("model_name") or "")
        version = str(row.get("version") or "")
        if model_name and version:
            artifacts_by_model_version.setdefault((model_name, version), []).append(row)

    def latest_artifact(model_name: str, version: str, artifact_id: str | None) -> dict[str, Any] | None:
        if artifact_id and artifact_id in artifacts_by_id:
            return artifacts_by_id[artifact_id]
        rows = artifacts_by_model_version.get((model_name, version), [])
        if not rows:
            return None
        return sorted(rows, key=lambda row: str(row.get("updated_at") or row.get("created_at") or ""), reverse=True)[0]

    def build_entry(model_name: str, fallback_entry: dict[str, Any]) -> dict[str, Any]:
        pointer = pointer_by_model.get(model_name)
        version = str((pointer or {}).get("champion_version") or "").strip()
        artifact_id = str((pointer or {}).get("champion_artifact_id") or "").strip() or None
        artifact = latest_artifact(model_name, version, artifact_id) if pointer and version else None
        block_reason = None if pointer and version else "missing_d1_champion_pointer"
        block_reason = block_reason or _artifact_block_reason(artifact)
        entry = dict(fallback_entry or {})
        entry["version"] = version or str(entry.get("version") or "")
        entry["status"] = "retired" if block_reason else "active"
        entry["serving_owner"] = "model_champion_pointers"
        entry["serving_artifact_id"] = artifact_id
        entry["serving_block_reason"] = block_reason
        if artifact:
            entry["gcs_path"] = str(artifact.get("artifact_path") or _default_artifact_path(model_name, version))
            entry["metadata_path"] = str(artifact.get("metadata_path") or _default_metadata_path(model_name, version))
            entry["candidate_type"] = artifact.get("candidate_type")
            entry["offline_gate_decision"] = artifact.get("offline_gate_decision")
            entry["live_gate_status"] = artifact.get("live_gate_status")
        elif version:
            entry.setdefault("gcs_path", _default_artifact_path(model_name, version))
            entry.setdefault("metadata_path", _default_metadata_path(model_name, version))
        _copy_ic_fields(entry, artifact=artifact, pointer=pointer, fallback=fallback_entry or {})
        return entry

    for model_name in required_models:
        pool["models"][model_name] = build_entry(model_name, pool["models"].get(model_name) or {})
    for model_name in sidecar_models:
        fallback_entry = pool["l2_feature_sidecars"].get(model_name) or pool["models"].get(model_name) or {}
        entry = build_entry(model_name, fallback_entry)
        entry["role"] = "l2_feature_sidecar"
        entry["direct_prediction"] = False
        pool["l2_feature_sidecars"][model_name] = entry
        pool["models"].pop(model_name, None)
    return pool


def _query_rows(sql: str, params: list[Any] | None = None) -> list[dict[str, Any]]:
    from . import d1_client

    return d1_client.query(sql, params=params or [], timeout=30.0)


def load_d1_champion_pool(*, fallback_pool: dict[str, Any] | None = None) -> dict[str, Any]:
    pointers = _query_rows(
        """
        SELECT model_name, champion_version, champion_artifact_id,
               promotion_reason, promotion_evidence_json, updated_at
        FROM model_champion_pointers
        """
    )
    artifacts = _query_rows(
        """
        SELECT artifact_id, model_name, version, candidate_type, state,
               artifact_path, metadata_path, offline_gate_decision,
               live_gate_status, live_evidence_json, offline_evidence_json,
               updated_at, created_at
        FROM model_artifact_registry
        WHERE model_name IS NOT NULL
        """
    )
    return build_pool_from_champion_pointers(
        pointers=pointers,
        artifacts=artifacts,
        fallback_pool=fallback_pool,
    )


def resolve_serving_pool(fallback_pool: dict[str, Any] | None) -> dict[str, Any] | None:
    if not d1_champion_serving_enabled():
        return fallback_pool
    if not _d1_env_configured():
        pool = copy.deepcopy(fallback_pool or {})
        pool["source_of_truth"] = "model_pool.json"
        pool["serving_owner_warning"] = "d1_champion_env_missing_local_compat"
        return pool
    try:
        return load_d1_champion_pool(fallback_pool=fallback_pool)
    except Exception:
        if os.environ.get("MODEL_SERVING_ALLOW_GCS_COMPAT_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}:
            pool = copy.deepcopy(fallback_pool or {})
            pool["source_of_truth"] = "model_pool.json"
            pool["serving_owner_warning"] = "d1_champion_unavailable_gcs_compat_fallback"
            return pool
        raise
