"""Stable identity for L4/Fusion serving artifacts.

Only fields that can change a served prediction participate in the fingerprint.
Validation telemetry and generation timestamps are deliberately excluded.
"""
from __future__ import annotations

import hashlib
import json
from typing import Any


def _model_payload(artifact: dict[str, Any]) -> dict[str, Any]:
    owner = str(artifact.get("expected_return_owner") or "").strip()
    common = {
        "expected_return_owner": owner,
        "model_version": str(artifact.get("model_version") or "").strip(),
        "artifact_contract_version": artifact.get("artifact_contract_version"),
        "feature_semantic_version": artifact.get("feature_semantic_version"),
        "label_schema_version": artifact.get("label_schema_version"),
        "trained_until": artifact.get("trained_until"),
        "horizon_days": artifact.get("horizon_days"),
        "cost_model_bps": artifact.get("cost_model_bps"),
        "output_is_net_of_costs": artifact.get("output_is_net_of_costs"),
        "feature_names": artifact.get("feature_names"),
    }
    if owner == "allocator_ev_fusion":
        residual = artifact.get("residual_adjustment_model")
        residual = residual if isinstance(residual, dict) else {}
        common.update({
            "expected_return_semantic": artifact.get("expected_return_semantic"),
            "base_expected_return_owner": artifact.get("base_expected_return_owner"),
            "policy_value_heads": artifact.get("policy_value_heads"),
            "residual_intercept": residual.get("intercept"),
            "residual_coefficients": residual.get("coefficients"),
            "residual_output_clip": artifact.get("residual_output_clip"),
        })
    else:
        common.update({
            "resolver_method": artifact.get("resolver_method"),
            "intercept": artifact.get("intercept"),
            "coefficients": artifact.get("coefficients"),
            "output_clip": artifact.get("output_clip"),
        })
    return common


def expected_return_artifact_identity(artifact: dict[str, Any]) -> dict[str, str]:
    owner = str(artifact.get("expected_return_owner") or "").strip()
    version = str(artifact.get("model_version") or "").strip()
    if owner not in {"l4_alpha_ev", "allocator_ev_fusion"}:
        raise ValueError("expected_return_artifact_owner_invalid")
    if not version:
        raise ValueError("expected_return_artifact_model_version_missing")
    canonical = json.dumps(
        _model_payload(artifact),
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
        allow_nan=False,
    )
    return {
        "artifact_id": f"{owner}:{version}",
        "model_fingerprint": hashlib.sha256(canonical.encode("utf-8")).hexdigest(),
    }


def attach_expected_return_artifact_identity(artifact: dict[str, Any]) -> dict[str, Any]:
    artifact.update(expected_return_artifact_identity(artifact))
    return artifact
