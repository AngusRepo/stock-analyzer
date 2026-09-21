"""Verified diagnostic forecast identity; no alpha vote or trained-feature grant."""
import re

SCHEMA='timesfm-verified-evidence-v1'


def verified_evidence(artifact, metadata):
    contract=metadata.get('timesfm_evidence_contract') or {}
    checksum=str(artifact.get('checksum') or '').removeprefix('sha256:')
    return (artifact.get('model_name')=='TimesFM'
        and artifact.get('candidate_type')=='manual_hotfix'
        and contract.get('schema_version')==SCHEMA
        and contract.get('artifact_id')==artifact.get('artifact_id')
        and contract.get('version')==artifact.get('version')
        and contract.get('artifact_path')==artifact.get('artifact_path')
        and re.fullmatch('[a-f0-9]{64}',checksum) is not None
        and contract.get('config_sha256')==checksum
        and contract.get('direct_alpha_blocked') is True
        and contract.get('trained_feature_adoption') is False
        and contract.get('efficacy_status')=='unproven'
        and isinstance(contract.get('source_reference'),str) and bool(contract['source_reference'].strip()))
