"""Read immutable sequence metric semantics without rewriting old artifacts.

The reviewed 200ed626 NeuralForecast producer calls date_market_rank_ic_evidence
(average ties, same-date/market cohorts, constant predictions neutral) but omits
its semantic tag. Only its checksum-bound training attestation is compatible.
Unknown producers and explicit conflicting declarations remain rejected.
Keep this pure contract identical in Controller and Modal.
"""
from __future__ import annotations
import hashlib
import json
from typing import Any

RANK_IC_SEMANTIC_VERSION = "same-date-average-rank-tie-neutral-spearman-v2"
TARGET_SEMANTIC_VERSION = "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
REVIEWED_NF_PRODUCERS = frozenset({"200ed626624970b1eaf880279e7ad262c2be6fde"})


def sequence_rank_ic_semantic(metadata: dict[str, Any], model_name: str) -> str | None:
    evidence = metadata.get("model_cpcv")
    evidence = evidence if isinstance(evidence, dict) else {}
    declared = [str(value).strip() for value in (
        metadata.get("rank_ic_semantic_version"), evidence.get("rank_ic_semantic_version")
    ) if value is not None and str(value).strip()]
    if declared:
        return RANK_IC_SEMANTIC_VERSION if set(declared) == {RANK_IC_SEMANTIC_VERSION} else None
    if model_name not in {"PatchTST", "iTransformer"}:
        return None
    attestation = metadata.get("model_training_config_attestation")
    if not isinstance(attestation, dict):
        return None
    unsigned = {key: value for key, value in attestation.items() if key != "attestation_checksum"}
    digest = hashlib.sha256(json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
    config = attestation.get("effective_config") or {}
    design = evidence.get("validation_design") or {}
    if not isinstance(config, dict) or not isinstance(design, dict):
        return None
    if (
        attestation.get("schema_version") != "model-training-config-attestation-v2"
        or attestation.get("model_name") != model_name
        or attestation.get("producer_source_sha") not in REVIEWED_NF_PRODUCERS
        or attestation.get("attestation_checksum") != digest
        or metadata.get("schema_version") != f"neuralforecast_{model_name.lower()}_universal_v1_metadata_v1"
        or metadata.get("target_semantic_version") != TARGET_SEMANTIC_VERSION
        or config.get("target_semantic_version") != TARGET_SEMANTIC_VERSION
        or config.get("seq_len") != metadata.get("seq_len")
        or config.get("pred_len") != metadata.get("pred_len")
        or evidence.get("method") != "purged_walk_forward_retrain_rank_ic"
        or design.get("refit_each_fold") is not True
        or design.get("non_overlapping_horizons") is not True
    ):
        return None
    return RANK_IC_SEMANTIC_VERSION
