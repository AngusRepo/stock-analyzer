from __future__ import annotations

import copy
import json
import os
from datetime import datetime, timezone
from typing import Any

from services.evidence_contracts import LABEL_SCHEMA_VERSION

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
SERVING_OK_OFFLINE_DECISIONS = {"STRONG_PASS", "PASS"}
SERVING_BAD_LIVE_STATUSES = {"failed", "rolling_ic_failed", "live_gate_failed"}
SERVING_IC_PRIOR_SCHEMA_VERSION = "version-bound-purged-oof-ic-prior-v1"
SERVING_IC_PRIOR_METHODS = {
    "outer_purged_walk_forward_rank_ic",
    "purged_walk_forward_retrain_rank_ic",
}
IC_STATE_FIELDS = (
    "rolling_ic",
    "ic_4w_avg",
    "weekly_ic",
    "consecutive_negative_weeks",
    "last_ic_status",
    "last_ic_root_cause",
    "last_ic_sample_count",
    "last_ic_score_sources",
    "last_ic_by_segment",
    "last_ic_error",
    "last_ic_diagnostics",
    "last_ic_evaluation_contract",
    "last_ic_semantic_version",
    "last_ic_target_semantic_version",
    "last_ic_artifact_version",
)

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


def _artifact_metadata(artifact: dict[str, Any] | None) -> dict[str, Any]:
    source = artifact or {}
    direct = _json_obj(source.get("metadata"))
    if direct:
        return direct
    offline = _json_obj(source.get("offline_evidence_json"))
    registration = _json_obj(offline.get("registration"))
    return _json_obj(registration.get("metadata"))


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


def _artifact_block_reason(artifact: dict[str, Any] | None, *, model_name: str) -> str | None:
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
    artifact_path = str(artifact.get("artifact_path") or "").strip()
    if not artifact_path:
        return "missing_artifact_path"
    expected_ext = str(ARTIFACT_EXTENSIONS.get(model_name) or "").strip().lower()
    actual_ext = artifact_path.rsplit(".", 1)[-1].lower() if "." in artifact_path else ""
    if expected_ext and actual_ext != expected_ext:
        return f"artifact_extension_{actual_ext or 'missing'}_expected_{expected_ext}"
    if model_name in DIRECT_ALPHA_MODELS:
        target_semantic = str(_artifact_metadata(artifact).get("target_semantic_version") or "").strip()
        if target_semantic != LABEL_SCHEMA_VERSION:
            return f"artifact_target_semantic_{target_semantic or 'missing'}_expected_{LABEL_SCHEMA_VERSION}"
    return None


def _first_number(*values: Any) -> float | None:
    for value in values:
        try:
            if value is not None:
                return float(value)
        except (TypeError, ValueError):
            continue
    return None


def build_serving_ic_prior(artifact: dict[str, Any] | None) -> dict[str, Any] | None:
    source = artifact or {}
    if str(source.get("candidate_type") or "").strip() != "oof_full_fit_release":
        return None
    if str(source.get("offline_gate_decision") or "").strip().upper() not in SERVING_OK_OFFLINE_DECISIONS:
        return None

    metadata = _artifact_metadata(source)
    target_semantic = str(metadata.get("target_semantic_version") or "").strip()
    if target_semantic != LABEL_SCHEMA_VERSION:
        return None

    offline = _json_obj(source.get("offline_evidence_json"))
    registration = _json_obj(offline.get("registration"))
    cpcv = _json_obj(metadata.get("model_cpcv") or registration.get("model_cpcv"))
    method = str(cpcv.get("method") or "").strip()
    decision = str(cpcv.get("decision") or "").strip().upper()
    if method not in SERVING_IC_PRIOR_METHODS or decision != "PASS" or cpcv.get("passed") is not True:
        return None

    value = _first_number(cpcv.get("oos_ic_mean"))
    if value is None or value <= 0:
        return None

    version = str(source.get("version") or "").strip()
    artifact_id = str(source.get("artifact_id") or "").strip()
    if not version or not artifact_id:
        return None

    return {
        "schema_version": SERVING_IC_PRIOR_SCHEMA_VERSION,
        "value": value,
        "source": "candidate_scoped_purged_oof_model_cpcv",
        "artifact_id": artifact_id,
        "artifact_version": version,
        "target_semantic_version": target_semantic,
        "method": method,
        "fold_count": int(cpcv.get("folds") or 0),
        "positive_fold_ratio": _first_number(cpcv.get("positive_fold_ratio")),
        "sample_count": int(metadata.get("sample_count") or registration.get("sample_count") or 0),
    }


def _live_ic_source_matches(
    source: dict[str, Any],
    *,
    artifact_version: str,
    target_semantic_version: str,
) -> bool:
    contract = _json_obj(source.get("last_ic_evaluation_contract"))
    source_version = str(
        source.get("last_ic_artifact_version")
        or contract.get("artifact_version")
        or ""
    ).strip()
    source_target = str(
        source.get("last_ic_target_semantic_version")
        or contract.get("target_semantic_version")
        or ""
    ).strip()
    return source_version == artifact_version and source_target == target_semantic_version


def _copy_ic_fields(entry: dict[str, Any], *, artifact: dict[str, Any] | None, pointer: dict[str, Any] | None, fallback: dict[str, Any]) -> None:
    live = _json_obj((artifact or {}).get("live_evidence_json"))
    promotion = _json_obj((pointer or {}).get("promotion_evidence_json"))
    artifact_version = str(entry.get("version") or "").strip()
    target_semantic = str(entry.get("target_semantic_version") or "").strip()
    sources = [
        source
        for source in (promotion, live, fallback)
        if _live_ic_source_matches(
            source,
            artifact_version=artifact_version,
            target_semantic_version=target_semantic,
        )
    ]

    for key in IC_STATE_FIELDS:
        entry[key] = [] if key == "weekly_ic" else None

    rolling_ic = _first_number(*(source.get("rolling_ic") for source in sources), *(source.get("live_ic") for source in sources))
    ic_4w = _first_number(*(source.get("ic_4w_avg") for source in sources))
    if rolling_ic is not None:
        entry["rolling_ic"] = rolling_ic
    if ic_4w is not None:
        entry["ic_4w_avg"] = ic_4w

    for key in IC_STATE_FIELDS:
        if key in {"rolling_ic", "ic_4w_avg"}:
            continue
        for source in sources:
            value = source.get(key)
            if value is not None:
                entry[key] = value
                break
    entry["serving_ic_prior"] = build_serving_ic_prior(artifact)
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
        block_reason = block_reason or _artifact_block_reason(artifact, model_name=model_name)

        entry = dict(fallback_entry or {})
        entry["version"] = version or str(entry.get("version") or "")
        entry["status"] = "retired" if block_reason else "active"
        entry["serving_owner"] = "model_champion_pointers"
        entry["serving_artifact_id"] = artifact_id
        entry["serving_block_reason"] = block_reason
        if artifact:
            artifact_metadata = _artifact_metadata(artifact)
            entry["gcs_path"] = str(artifact.get("artifact_path") or _default_artifact_path(model_name, version))
            entry["metadata_path"] = str(artifact.get("metadata_path") or _default_metadata_path(model_name, version))
            entry["candidate_type"] = artifact.get("candidate_type")
            entry["offline_gate_decision"] = artifact.get("offline_gate_decision")
            entry["live_gate_status"] = artifact.get("live_gate_status")
            entry["target_semantic_version"] = artifact_metadata.get("target_semantic_version")
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
            current = current or {}
            retirement_patch = {
                key: champion.get(key)
                for key in (
                    "version",
                    "status",
                    "gcs_path",
                    "metadata_path",
                    "serving_owner",
                    "serving_artifact_id",
                    "serving_block_reason",
                    "offline_gate_decision",
                    "live_gate_status",
                    "target_semantic_version",
                )
                if champion.get(key) is not None
            }
            retirement_patch["status"] = "retired"
            retirement_patch["production_weight"] = 0.0
            retirement_patch["serving_owner"] = None
            retirement_patch["serving_artifact_id"] = None
            diff = {
                key: {"from": current.get(key), "to": value}
                for key, value in retirement_patch.items()
                if current.get(key) != value
            }
            if diff:
                actions.append({
                    "action": "retire_invalid_model_pool_pointer",
                    "model_name": model_name,
                    "section": section,
                    "champion_section": champion_section,
                    "reason": block_reason or f"champion_status_{champion.get('status') or 'missing'}",
                    "diff": diff,
                    "patch": retirement_patch,
                })
            continue

        current = current or {}
        desired_keys = (
            "version",
            "status",
            "gcs_path",
            "metadata_path",
            "serving_owner",
            "serving_artifact_id",
            "offline_gate_decision",
            "live_gate_status",
            "target_semantic_version",
            "serving_ic_prior",
            "serving_ic_source",
            *IC_STATE_FIELDS,
        )
        desired_fields = {
            key: champion.get(key)
            for key in desired_keys
            if key in champion
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
        "apply_allowed": not blocked,
        "has_changes": bool(actions),
        "action_count": len(actions),
        "blocked_count": len(blocked),
        "actions": actions,
        "blocked": blocked,
    }


def apply_model_pool_reconcile_plan(
    *,
    model_pool: dict[str, Any],
    plan: dict[str, Any],
) -> dict[str, Any]:
    """Return a compat model_pool projection with D1 champion pointer patches applied.

    This function is pure and performs no GCS/D1 writes. It projects the
    authoritative D1 champion state and may be applied automatically only when
    the plan has no blocked entries.
    """

    if plan.get("blocked"):
        raise RuntimeError(f"model_pool_reconcile_blocked: {plan.get('blocked')}")
    updated = copy.deepcopy(model_pool or {})
    updated["models"] = dict(updated.get("models") or {})
    updated["l2_feature_sidecars"] = dict(updated.get("l2_feature_sidecars") or {})
    applied: list[dict[str, Any]] = []
    for action in plan.get("actions") or []:
        if not isinstance(action, dict) or action.get("action") not in {
            "update_model_pool_pointer",
            "retire_invalid_model_pool_pointer",
        }:
            continue
        model_name = str(action.get("model_name") or "").strip()
        section = str(action.get("section") or "models").strip()
        patch = action.get("patch") if isinstance(action.get("patch"), dict) else {}
        if not model_name or section not in {"models", "l2_feature_sidecars"}:
            continue
        target = updated.setdefault(section, {})
        current = dict(target.get(model_name) or {})
        current.update(patch)
        target[model_name] = current
        applied.append({
            "model_name": model_name,
            "section": section,
            "fields": sorted(patch.keys()),
        })
    updated["last_updated"] = datetime.now(timezone.utc).isoformat()
    updated["source_of_truth"] = "model_champion_pointers"
    updated["compat_shape"] = "model_pool"
    updated["reconcile_evidence"] = {
        "schema_version": "model-pool-reconcile-apply-v1",
        "source": plan.get("source") or "model_champion_pointers/model_artifact_registry",
        "applied_count": len(applied),
        "applied": applied,
    }
    return updated


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
