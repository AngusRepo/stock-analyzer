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
REVIEWED_TIMEXER_PRODUCERS = frozenset({"4bcc8d1f7742b73265ba0e7021f5bfc4c022fc24"})
REVIEWED_NF_PRODUCERS = frozenset({"200ed626624970b1eaf880279e7ad262c2be6fde"})


def sequence_rank_ic_semantic(metadata: dict[str, Any], model_name: str) -> str | None:
    evidence = metadata.get("model_cpcv")
    evidence = evidence if isinstance(evidence, dict) else {}
    declared = [str(value).strip() for value in (
        metadata.get("rank_ic_semantic_version"), evidence.get("rank_ic_semantic_version")
    ) if value is not None and str(value).strip()]
    if declared:
        return RANK_IC_SEMANTIC_VERSION if set(declared) == {RANK_IC_SEMANTIC_VERSION} else None
    if model_name not in {"PatchTST", "iTransformer", "TimeXer"}:
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
    if model_name == "TimeXer":
        # Reviewed producer uses date_market_rank_ic_evidence for OOF but
        # omitted the metric tag in full-fit sidecars. Preserve those objects.
        from .timexer_contract import metadata_contract
        try:
            contract = metadata_contract(metadata)
        except ValueError:
            return None
        lineage = attestation.get("input_lineage") or {}
        valid = (
            attestation.get("schema_version") == "model-training-config-attestation-v2"
            and attestation.get("model_name") == model_name
            and attestation.get("attestation_checksum") == digest
            and attestation.get("producer_source_sha") in REVIEWED_TIMEXER_PRODUCERS
            and metadata.get("producer_source_sha") == attestation.get("producer_source_sha")
            and metadata.get("full_fit_only") is True
            and attestation.get("dataset_snapshot_schema_version") == "active8-oof-full-fit-prep-lineage-v2"
            and metadata.get("target_semantic_version") == config.get("target_semantic_version") == TARGET_SEMANTIC_VERSION
            and config.get("settings") == metadata.get("settings")
            and config.get("exogenous") == metadata.get("exogenous") == (contract['variant'] == 'exo137')
            and config.get("device") == metadata.get("device") == "cuda"
            and config.get("checkpoint_selection") == metadata.get("checkpoint_selection") == "purged_inner_epoch_then_full_train_refit"
            and metadata.get("source_manifest_checksum") == lineage.get("prep_manifest_checksum")
            and isinstance(lineage.get("source_manifest_checksum"), str)
            and len(lineage["source_manifest_checksum"]) == 64
            and attestation.get("dataset_snapshot_id") == "oof_full_fit:" + str(lineage.get("source_cohort_id")) + ":" + lineage["source_manifest_checksum"]
        )
        return RANK_IC_SEMANTIC_VERSION if valid else None
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
