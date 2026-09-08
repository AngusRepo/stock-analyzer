"""Verify the original producer of each immutable fold across release boundaries."""
from __future__ import annotations
import hashlib
import json


def verified_fold_producer_sha(manifest: dict, window: dict, *, bucket, cache: dict | None = None) -> str:
    prefix = str(window.get("source_prep_gcs_prefix") or manifest.get("prep_gcs_prefix") or "").rstrip("/")
    expected = str(window.get("source_prep_manifest_checksum") or (manifest.get("prep_manifest") or {}).get("manifest_checksum") or "")
    if not prefix or prefix == "universal" or len(expected) != 64:
        raise ValueError("active8_oof_fold_prep_identity_missing")
    key = (prefix, expected)
    if cache is not None and key in cache:
        source = cache[key]
    else:
        raw = bucket.blob(f"{prefix}/prep/manifest.json").download_as_bytes()
        prep = json.loads(raw.decode("utf-8"))
        unsigned = {k: v for k, v in prep.items() if k != "manifest_checksum"}
        actual = hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()
        source = str(prep.get("producer_source_sha") or "").strip().lower()
        if (actual != expected or prep.get("manifest_checksum") != expected
            or prep.get("schema_version") != "active8-canonical-adjusted-prep-v3"
            or prep.get("status") != "ready" or str(prep.get("output_gcs_prefix") or "").rstrip("/") != prefix
            or prep.get("feature_semantic_version") != "formal137-pit-rolling-rank-and-imputation-v2"
            or prep.get("feature_imputation_semantic") != "prior_252_row_median_then_zero_v2"
            or prep.get("target_semantic_version") != "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4"
            or float(prep.get("roundtrip_cost_bps") or 0) != 18.0
            or len(source) != 40 or any(c not in "0123456789abcdef" for c in source)):
            raise ValueError("active8_oof_fold_prep_lineage_mismatch")
        if cache is not None:
            cache[key] = source
    declared = str(window.get("source_producer_source_sha") or "").strip().lower()
    if declared and declared != source:
        raise ValueError("active8_oof_fold_producer_attestation_mismatch")
    return source
