"""R33 ensemble object: seven equal-weight models and the cross-fit serving table (slice A §2).

The object binds the seven base artifacts, the sealed monthly bundle it came from
and the serving calibration under one payload checksum. Every consumer validates
the whole object first, so a pointer cannot claim one identity and carry another
roster or table.
"""
from __future__ import annotations

import re

from services.r33_crossfit_serving import validate_serving
from services.r33_isotonic_calibration import MODELS, checksum

SCHEMA = "r33-equal7-ensemble-v1"
KIND = "r33_equal7_isotonic"
_BODY = ("schema_version", "kind", "cohort_id", "model_order", "selected_models", "base_artifacts",
         "observation_artifacts", "base_artifact_set_checksum", "variant", "source_bundle",
         "serving_calibration", "validation")
_ARTIFACT = ("artifact_id", "version", "checksum")
_SOURCE = ("path", "sha256", "manifest_checksum", "oof_checks_checksum", "source_calibration_checksum")
_VALIDATION = ("decision", "oof_checks_status", "pit_certified", "pit_certification_sha256")
_HEX = re.compile(r"[0-9a-f]{64}")
_REGISTRY_CHECKSUM = re.compile(r"(?:sha256:)?[0-9a-f]{64}")     # model_artifact_registry stores "sha256:<hex>"


def _sha(value) -> bool:
    return isinstance(value, str) and _HEX.fullmatch(value) is not None


def _sealed(body: dict) -> dict:
    payload = checksum(body)
    return {**body, "artifact_id": f"r33-equal7:{body['cohort_id']}:{payload[:16]}", "payload_checksum": payload}


def build_ensemble(*, cohort_id: str, base_artifacts: dict, source_bundle: dict, serving_calibration: dict,
                   validation: dict) -> dict:
    artifacts = {m: {k: base_artifacts[m][k] for k in _ARTIFACT} for m in MODELS}
    body = dict(schema_version=SCHEMA, kind=KIND, cohort_id=cohort_id, model_order=list(MODELS),
                selected_models=list(MODELS), base_artifacts=artifacts,
                observation_artifacts={m: dict(v) for m, v in artifacts.items()},
                base_artifact_set_checksum=checksum(artifacts), variant=serving_calibration["variant"],
                source_bundle={k: source_bundle[k] for k in _SOURCE}, serving_calibration=serving_calibration,
                validation={k: validation[k] for k in _VALIDATION})
    ensemble = _sealed(body)
    validate_ensemble(ensemble)
    return ensemble


def is_r33(ensemble) -> bool:
    return isinstance(ensemble, dict) and ensemble.get("kind") == KIND


def validate_ensemble(ensemble: dict) -> dict:
    """The whole object, recomputed: roster, artifact set, source, serving table, checksum, id.

    payload_checksum covers every field except artifact_id (derived from it) and
    itself; this is not the active8 convention, so r33 objects are validated here only.
    """
    if not isinstance(ensemble, dict) or set(ensemble) != {*_BODY, "artifact_id", "payload_checksum"}:
        raise ValueError("r33_ensemble_contract")
    artifacts, source = ensemble["base_artifacts"], ensemble["source_bundle"]
    validation = ensemble["validation"]
    if (ensemble["schema_version"] != SCHEMA or ensemble["kind"] != KIND
            or not isinstance(ensemble["cohort_id"], str) or not ensemble["cohort_id"]
            or ensemble["model_order"] != list(MODELS) or ensemble["selected_models"] != list(MODELS)
            or not isinstance(artifacts, dict) or set(artifacts) != set(MODELS)
            or any(not isinstance(artifacts[m], dict) or set(artifacts[m]) != set(_ARTIFACT)
                   or not isinstance(artifacts[m]["artifact_id"], str) or not artifacts[m]["artifact_id"]
                   or not isinstance(artifacts[m]["version"], str) or not artifacts[m]["version"]
                   or not isinstance(artifacts[m]["checksum"], str)
                   or _REGISTRY_CHECKSUM.fullmatch(artifacts[m]["checksum"]) is None for m in MODELS)
            or ensemble["observation_artifacts"] != artifacts
            or not isinstance(source, dict) or set(source) != set(_SOURCE)
            or not isinstance(source["path"], str) or not source["path"]
            or not all(_sha(source[k]) for k in _SOURCE[1:])
            or not isinstance(validation, dict) or set(validation) != set(_VALIDATION)
            or validation["decision"] != "PASS" or validation["oof_checks_status"] != "pass"
            or validation["pit_certified"] is not True or not _sha(validation["pit_certification_sha256"])):
        raise ValueError("r33_ensemble_contract")
    if ensemble["base_artifact_set_checksum"] != checksum(artifacts):
        raise ValueError("r33_ensemble_artifact_set_checksum")
    calibration = validate_serving(ensemble["serving_calibration"],
                                   source_checksum=source["source_calibration_checksum"])
    if ensemble["variant"] != calibration["variant"]:
        raise ValueError("r33_ensemble_contract")
    if _sealed({k: ensemble[k] for k in _BODY}) != ensemble:
        raise ValueError("r33_ensemble_payload_checksum")
    return ensemble
