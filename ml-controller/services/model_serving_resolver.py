from __future__ import annotations

import json
import os
import re
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
SEQUENCE_ALPHA_MODELS = ("DLinear", "PatchTST", "iTransformer")
FORMAL_FEATURE_MODELS = ("LightGBM", "XGBoost", "ExtraTrees", "TabM", "GNN")
FORMAL_FEATURE_SEMANTIC_VERSION = "formal137-pit-rolling-rank-and-imputation-v2"
FORMAL_GNN_GRAPH_SEMANTIC_VERSION = "gnn-same-date-feature-cosine-sector-v2"
FORMAL_RANK_IC_SEMANTIC_VERSION = "same-date-average-rank-tie-neutral-spearman-v2"
SEQUENCE_CONTRACT_FIELDS = ("seq_len", "pred_len", "sequence_contract")
SEQUENCE_CONTRACT_SCHEMA_VERSION = "model-serving-sequence-contract-v1"
L2_SIDECARS = ("TimesFM",)
SERVING_OK_STATES = {"production"}
SERVING_OK_OFFLINE_DECISIONS = {"STRONG_PASS", "PASS"}
L2_SIDECAR_OK_OFFLINE_DECISIONS = {
    *SERVING_OK_OFFLINE_DECISIONS,
    "PRODUCTION_BACKFILL",
}
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


def _artifact_checksum(artifact: dict[str, Any] | None) -> str | None:
    source = artifact or {}
    metadata = _artifact_metadata(source)
    offline = _json_obj(source.get("offline_evidence_json"))
    registration = _json_obj(offline.get("registration"))
    raw = (
        source.get("checksum")
        or registration.get("checksum")
        or metadata.get("artifact_checksum")
        or metadata.get("checksum")
    )
    checksum = str(raw or "").strip().lower()
    return checksum if re.fullmatch(r"sha256:[0-9a-f]{64}", checksum) else None


def _positive_int(value: Any) -> int | None:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return None
    return parsed if parsed > 0 else None


def _sequence_artifact_contract(
    model_name: str,
    artifact: dict[str, Any] | None,
) -> dict[str, Any] | None:
    if model_name not in SEQUENCE_ALPHA_MODELS or not artifact:
        return None
    metadata = _artifact_metadata(artifact)
    seq_len = _positive_int(metadata.get("seq_len"))
    pred_len = _positive_int(metadata.get("pred_len"))
    rank_ic_semantic = str(metadata.get("rank_ic_semantic_version") or "").strip()
    version = str(artifact.get("version") or metadata.get("version") or "").strip()
    artifact_id = str(artifact.get("artifact_id") or "").strip()
    if (
        seq_len is None
        or pred_len is None
        or rank_ic_semantic != FORMAL_RANK_IC_SEMANTIC_VERSION
        or not version
        or not artifact_id
    ):
        return None
    return {
        "schema_version": SEQUENCE_CONTRACT_SCHEMA_VERSION,
        "source": "model_artifact_registry",
        "model": model_name,
        "artifact_id": artifact_id,
        "version": version,
        "seq_len": seq_len,
        "pred_len": pred_len,
        "rank_ic_semantic_version": rank_ic_semantic,
    }


def _folder(model_name: str) -> str:
    if model_name == "TimesFM":
        return "timesfm"
    return model_name.lower().replace("-", "_")


def _default_artifact_path(model_name: str, version: str) -> str:
    ext = ARTIFACT_EXTENSIONS.get(model_name, "joblib")
    return f"universal/{_folder(model_name)}/{version}.{ext}"


def _default_metadata_path(model_name: str, version: str) -> str:
    return f"universal/{_folder(model_name)}/metadata_{version}.json"


def _artifact_for_exact_pointer(
    *,
    model_name: str,
    version: str,
    artifact_id: str | None,
    artifacts_by_id: dict[str, dict[str, Any]],
) -> dict[str, Any] | None:
    if not artifact_id:
        return None
    artifact = artifacts_by_id.get(artifact_id)
    if not artifact:
        return None
    if (
        str(artifact.get("model_name") or "") != model_name
        or str(artifact.get("version") or "") != version
    ):
        return None
    return artifact

def _artifact_block_reason(
    artifact: dict[str, Any] | None,
    *,
    model_name: str,
    artifact_role: str,
) -> str | None:
    if not artifact:
        return "missing_registry_artifact"
    state = str(artifact.get("state") or "").strip()
    if state not in SERVING_OK_STATES:
        return f"artifact_state_{state or 'missing'}"
    offline_decision = str(artifact.get("offline_gate_decision") or "").strip().upper()
    allowed_offline_decisions = (
        L2_SIDECAR_OK_OFFLINE_DECISIONS
        if artifact_role == "l2_feature_sidecar"
        else SERVING_OK_OFFLINE_DECISIONS
    )
    if offline_decision and offline_decision not in allowed_offline_decisions:
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
    if _artifact_checksum(artifact) is None:
        return "artifact_checksum_missing_or_invalid"
    if model_name in DIRECT_ALPHA_MODELS:
        if str(artifact.get("candidate_type") or "") != "oof_full_fit_release":
            return "artifact_candidate_type_not_canonical_oof_release"
        metadata = _artifact_metadata(artifact)
        target_semantic = str(metadata.get("target_semantic_version") or "").strip()
        if target_semantic != LABEL_SCHEMA_VERSION:
            return f"artifact_target_semantic_{target_semantic or 'missing'}_expected_{LABEL_SCHEMA_VERSION}"
        if model_name in FORMAL_FEATURE_MODELS:
            feature_semantic = str(metadata.get("feature_semantic_version") or "").strip()
            if feature_semantic != FORMAL_FEATURE_SEMANTIC_VERSION:
                return (
                    f"artifact_feature_semantic_{feature_semantic or 'missing'}_"
                    f"expected_{FORMAL_FEATURE_SEMANTIC_VERSION}"
                )
        if model_name == "GNN":
            graph = metadata.get("graph_context") if isinstance(metadata.get("graph_context"), dict) else {}
            graph_semantic = str(graph.get("semantic_version") or "").strip()
            if graph_semantic != FORMAL_GNN_GRAPH_SEMANTIC_VERSION:
                return (
                    f"artifact_gnn_graph_semantic_{graph_semantic or 'missing'}_"
                    f"expected_{FORMAL_GNN_GRAPH_SEMANTIC_VERSION}"
                )
    if artifact_role == "l2_feature_sidecar" and str(artifact.get("candidate_type") or "") != "timesfm_l175_l2_feature_release":
        return "artifact_candidate_type_not_timesfm_feature_release"
    if model_name in SEQUENCE_ALPHA_MODELS and _sequence_artifact_contract(model_name, artifact) is None:
        return "artifact_sequence_contract_missing_or_invalid"
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


def _copy_ic_fields(entry: dict[str, Any], *, artifact: dict[str, Any] | None, pointer: dict[str, Any] | None) -> None:
    live = _json_obj((artifact or {}).get("live_evidence_json"))
    promotion = _json_obj((pointer or {}).get("promotion_evidence_json"))
    artifact_version = str(entry.get("version") or "").strip()
    target_semantic = str(entry.get("target_semantic_version") or "").strip()
    sources = [
        source
        for source in (promotion, live)
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
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    pool: dict[str, Any] = {
        "schema_version": "model_pool_v3_d1_pointer_owned",
        "last_updated": datetime.now(timezone.utc).isoformat(),
        "source_of_truth": "model_champion_pointers",
        "models": {},
        "l2_feature_sidecars": {},
    }
    pointer_by_model = {str(row.get("model_name")): row for row in pointers if row.get("model_name")}
    artifacts_by_id = {str(row.get("artifact_id")): row for row in artifacts if row.get("artifact_id")}

    def build_entry(model_name: str, *, artifact_role: str) -> dict[str, Any]:
        pointer = pointer_by_model.get(model_name)
        version = str((pointer or {}).get("champion_version") or "").strip()
        artifact_id = str((pointer or {}).get("champion_artifact_id") or "").strip() or None
        artifact = _artifact_for_exact_pointer(
            model_name=model_name,
            version=version,
            artifact_id=artifact_id,
            artifacts_by_id=artifacts_by_id,
        ) if pointer and version else None
        block_reason = None if pointer and version else "missing_d1_champion_pointer"
        block_reason = block_reason or _artifact_block_reason(
            artifact,
            model_name=model_name,
            artifact_role=artifact_role,
        )
        entry: dict[str, Any] = {
            "version": version,
            "model_slot_status": "active",
            "status": "degraded" if block_reason else "active",
            "serving_eligible": not bool(block_reason),
            "serving_owner": "model_champion_pointers",
            "serving_artifact_id": artifact_id,
            "serving_block_reason": block_reason,
        }
        if artifact:
            artifact_metadata = _artifact_metadata(artifact)
            entry["gcs_path"] = str(artifact.get("artifact_path") or "")
            entry["metadata_path"] = str(artifact.get("metadata_path") or "")
            entry["checksum"] = _artifact_checksum(artifact)
            entry["candidate_type"] = artifact.get("candidate_type")
            entry["offline_gate_decision"] = artifact.get("offline_gate_decision")
            entry["live_gate_status"] = artifact.get("live_gate_status")
            entry["target_semantic_version"] = artifact_metadata.get("target_semantic_version")
            entry["feature_semantic_version"] = artifact_metadata.get("feature_semantic_version")
            graph = artifact_metadata.get("graph_context") if isinstance(artifact_metadata.get("graph_context"), dict) else {}
            entry["gnn_graph_semantic_version"] = graph.get("semantic_version") if model_name == "GNN" else None
            sequence_contract = _sequence_artifact_contract(model_name, artifact)
            if sequence_contract:
                entry["seq_len"] = sequence_contract["seq_len"]
                entry["pred_len"] = sequence_contract["pred_len"]
                entry["sequence_contract"] = sequence_contract
        _copy_ic_fields(entry, artifact=artifact, pointer=pointer)
        return entry

    for model_name in required_models:
        pool["models"][model_name] = build_entry(model_name, artifact_role="direct_alpha")
    for model_name in sidecar_models:
        entry = build_entry(model_name, artifact_role="l2_feature_sidecar")
        entry["role"] = "l2_feature_sidecar"
        entry["direct_prediction"] = False
        pool["l2_feature_sidecars"][model_name] = entry
    return pool

def load_d1_champion_pool(
    *,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    from services.model_artifact_registry import list_artifacts_by_ids, list_champion_pointers

    pointers = list_champion_pointers()
    requested_models = set((*required_models, *sidecar_models))
    artifact_ids = list(dict.fromkeys(
        str(pointer.get("champion_artifact_id") or "").strip()
        for pointer in pointers
        if (
            str(pointer.get("model_name") or "").strip() in requested_models
            and str(pointer.get("champion_artifact_id") or "").strip()
        )
    ))
    artifacts = list_artifacts_by_ids(artifact_ids, max_ids=len(requested_models))
    return build_pool_from_champion_pointers(
        pointers=pointers,
        artifacts=artifacts,
        required_models=required_models,
        sidecar_models=sidecar_models,
    )

def resolve_serving_pool(
    *,
    required_models: tuple[str, ...] = DIRECT_ALPHA_MODELS,
    sidecar_models: tuple[str, ...] = L2_SIDECARS,
) -> dict[str, Any]:
    if not _d1_env_configured():
        raise RuntimeError("d1_champion_serving_environment_missing")
    return load_d1_champion_pool(
        required_models=required_models,
        sidecar_models=sidecar_models,
    )
