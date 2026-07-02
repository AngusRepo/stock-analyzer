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


def _serving_owner() -> str:
    return str(os.environ.get("MODEL_SERVING_OWNER") or "d1_champion").strip().lower()


def d1_champion_serving_enabled() -> bool:
    return _serving_owner() in {"d1", "d1_champion", "model_champion_pointers"}


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
    if model_name == "TimesFM":
        return "timesfm"
    return model_name.lower().replace("-", "_")


def _default_artifact_path(model_name: str, version: str) -> str:
    ext = ARTIFACT_EXTENSIONS.get(model_name, "joblib")
    return f"universal/{_folder(model_name)}/{version}.{ext}"


def _default_metadata_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/metadata_{version}.json"


def _latest_artifact_for_pointer(
    *,
    model_name: str,
    version: str,
    artifact_id: str | None,
    artifacts_by_id: dict[str, dict[str, Any]],
    artifacts_by_model_version: dict[tuple[str, str], list[dict[str, Any]]],
) -> dict[str, Any] | None:
    if artifact_id and artifact_id in artifacts_by_id:
        return artifacts_by_id[artifact_id]
    candidates = artifacts_by_model_version.get((model_name, version), [])
    if not candidates:
        return None
    return sorted(
        candidates,
        key=lambda row: str(row.get("updated_at") or row.get("created_at") or ""),
        reverse=True,
    )[0]


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

    def build_entry(model_name: str, fallback_entry: dict[str, Any]) -> dict[str, Any]:
        pointer = pointer_by_model.get(model_name)
        version = str((pointer or {}).get("champion_version") or "").strip()
        artifact_id = str((pointer or {}).get("champion_artifact_id") or "").strip() or None
        artifact = _latest_artifact_for_pointer(
            model_name=model_name,
            version=version,
            artifact_id=artifact_id,
            artifacts_by_id=artifacts_by_id,
            artifacts_by_model_version=artifacts_by_model_version,
        ) if pointer and version else None
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
        fallback_entry = (
            pool["l2_feature_sidecars"].get(model_name)
            or pool["models"].get(model_name)
            or {}
        )
        entry = build_entry(model_name, fallback_entry)
        entry["role"] = "l2_feature_sidecar"
        entry["direct_prediction"] = False
        pool["l2_feature_sidecars"][model_name] = entry
        pool["models"].pop(model_name, None)
    return pool


def _pool_entry(pool: dict[str, Any], model_name: str) -> tuple[str, dict[str, Any] | None]:
    models = pool.get("models") if isinstance(pool.get("models"), dict) else {}
    if model_name in models:
        entry = models.get(model_name)
        return "models", entry if isinstance(entry, dict) else None
    sidecars = pool.get("l2_feature_sidecars") if isinstance(pool.get("l2_feature_sidecars"), dict) else {}
    if model_name in sidecars:
        entry = sidecars.get(model_name)
        return "l2_feature_sidecars", entry if isinstance(entry, dict) else None
    return "models", None


def build_model_pool_reconcile_plan(
    *,
    model_pool: dict[str, Any],
    champion_pool: dict[str, Any],
    model_names: tuple[str, ...] = DIRECT_ALPHA_MODELS,
) -> dict[str, Any]:
    """Build a dry-run plan for reconciling compat model_pool pointers to D1 champions."""

    actions: list[dict[str, Any]] = []
    blocked: list[dict[str, Any]] = []
    for model_name in model_names:
        section, current = _pool_entry(model_pool, model_name)
        champion_section, champion = _pool_entry(champion_pool, model_name)
        if not champion:
            blocked.append({
                "model_name": model_name,
                "reason": "missing_d1_champion_entry",
                "section": champion_section,
            })
            continue
        block_reason = str(champion.get("serving_block_reason") or "").strip()
        if str(champion.get("status") or "").strip().lower() != "active" or block_reason:
            blocked.append({
                "model_name": model_name,
                "reason": block_reason or f"champion_status_{champion.get('status') or 'missing'}",
                "section": champion_section,
                "champion_version": champion.get("version"),
            })
            continue

        current = current or {}
        desired_fields = {
            key: champion.get(key)
            for key in (
                "version",
                "status",
                "gcs_path",
                "metadata_path",
                "serving_owner",
                "serving_artifact_id",
                "offline_gate_decision",
                "live_gate_status",
            )
            if champion.get(key) is not None
        }
        diff = {
            key: {"from": current.get(key), "to": value}
            for key, value in desired_fields.items()
            if current.get(key) != value
        }
        if diff:
            actions.append({
                "action": "update_model_pool_pointer",
                "model_name": model_name,
                "section": section,
                "champion_section": champion_section,
                "diff": diff,
                "patch": desired_fields,
            })

    return {
        "schema_version": "model-pool-reconcile-plan-v1",
        "source": "model_champion_pointers/model_artifact_registry",
        "mode": "dry_run",
        "apply_allowed": False,
        "has_changes": bool(actions),
        "action_count": len(actions),
        "blocked_count": len(blocked),
        "actions": actions,
        "blocked": blocked,
    }


def load_d1_champion_pool(
    *,
    fallback_pool: dict[str, Any] | None = None,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    from services.model_artifact_registry import list_artifact_registry, list_champion_pointers

    pointers = list_champion_pointers()
    artifacts = list_artifact_registry(limit=1000)
    return build_pool_from_champion_pointers(
        pointers=pointers,
        artifacts=artifacts,
        fallback_pool=fallback_pool,
        required_models=required_models,
        sidecar_models=sidecar_models,
    )


def resolve_serving_pool(
    fallback_pool: dict[str, Any] | None,
    *,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any] | None:
    if not d1_champion_serving_enabled():
        return fallback_pool
    if not _d1_env_configured():
        pool = copy.deepcopy(fallback_pool or {})
        pool["source_of_truth"] = "model_pool.json"
        pool["serving_owner_warning"] = "d1_champion_env_missing_local_compat"
        return pool
    try:
        return load_d1_champion_pool(
            fallback_pool=fallback_pool,
            required_models=required_models,
            sidecar_models=sidecar_models,
        )
    except Exception:
        if os.environ.get("MODEL_SERVING_ALLOW_GCS_COMPAT_FALLBACK", "").strip().lower() in {"1", "true", "yes", "on"}:
            pool = copy.deepcopy(fallback_pool or {})
            pool["source_of_truth"] = "model_pool.json"
            pool["serving_owner_warning"] = "d1_champion_unavailable_gcs_compat_fallback"
            return pool
        raise
