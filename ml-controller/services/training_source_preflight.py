"""Reject unsealed or mixed adjustment vintages before paid Active-8 dispatch.

This verifies the sequence provenance boundary. It is not a claim that all root
features, calendar sessions, or historical financial vintages are certified.
"""
from __future__ import annotations
import hashlib
import json


def _sealed_manifest(bucket, prefix: str, filename: str, *, compact: bool):
    if not prefix or prefix != prefix.strip().rstrip("/"):
        raise ValueError("training_source_prefix_invalid")
    blob=bucket.blob(f"{prefix}/prep/{filename}")
    if not blob.exists():
        raise ValueError(f"training_source_manifest_missing:{filename}")
    value=json.loads(blob.download_as_text().lstrip("\ufeff"))
    if not isinstance(value,dict):
        raise ValueError("training_source_manifest_invalid")
    unsigned={k:v for k,v in value.items() if k!="manifest_checksum"}
    options={"sort_keys":True}
    if compact:options["separators"]=(",",":")
    digest=hashlib.sha256(json.dumps(unsigned,**options).encode()).hexdigest()
    if value.get("manifest_checksum")!=digest or value.get("status")!="ready" or value.get("output_gcs_prefix")!=prefix:
        raise ValueError(f"training_source_manifest_invalid:{filename}")
    return value


def require_single_adjustment_capture(bucket, *, prep_gcs_prefix: str, sequence_gcs_prefix: str) -> dict:
    if bucket is None:
        raise ValueError("training_source_bucket_unavailable")
    prep=_sealed_manifest(bucket,prep_gcs_prefix,"manifest.json",compact=False)
    sequence=_sealed_manifest(bucket,sequence_gcs_prefix,"sequence_manifest.json",compact=True)
    if prep.get("sequence_gcs_prefix")!=sequence_gcs_prefix or prep.get("sequence_manifest_checksum")!=sequence["manifest_checksum"]:
        raise ValueError("training_source_sequence_binding_mismatch")
    daily=[x for x in sequence.get("lane_reports",[]) if isinstance(x,dict) and x.get("lane")=="daily_price"]
    if len(daily)!=1:
        raise ValueError("training_source_daily_price_provenance_missing")
    source=daily[0].get("source_uri") or {}
    if not isinstance(source,dict) or not isinstance(source.get("capture_id"),str) or not source["capture_id"].strip():
        raise ValueError("training_source_single_adjustment_capture_required")
    checksums=source.get("checksums") or {}
    for name,field in (("close","adj_close"),("open","adj_open")):
        uri=source.get(name)
        digest=checksums.get(field) if isinstance(checksums,dict) else None
        if not isinstance(uri,str) or not uri.startswith("gs://") or not isinstance(digest,str) or len(digest)!=64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("training_source_adjustment_capture_invalid")
    if source["close"].rsplit("/",1)[0]!=source["open"].rsplit("/",1)[0]:
        raise ValueError("training_source_adjustment_capture_mixed")
    binding=prep.get("price_capture") or {}
    if (binding.get("schema_version")!="training-price-capture-binding-v1"
            or binding.get("capture_id")!=source["capture_id"]
            or binding.get("sequence_manifest_checksum")!=sequence["manifest_checksum"]
            or len(str(binding.get("actual_price_values_sha256") or ""))!=64
            or any(binding.get("checksums",{}).get(k)!=checksums[k] for k in ("adj_close","adj_open"))):
        raise ValueError("training_source_root_price_binding_required")
    if binding.get("prior_venue_scope_sha256") is not None:
        raw = bucket.blob(binding["capture_manifest_path"]).download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != binding.get("capture_manifest_sha256"):
            raise ValueError("training_source_price_manifest_mismatch")
        from services.training_price_venue_scope import scope_from_manifest
        _, scope_sha = scope_from_manifest(json.loads(raw))
        if scope_sha != binding["prior_venue_scope_sha256"]:
            raise ValueError("training_source_price_venue_binding_mismatch")
    indicator=binding.get("indicator_capture") or {}
    if (indicator.get("recipe")!="Worker computeTechnicalIndicators, latest 70 observed raw bars, minimum 20"
            or not isinstance(indicator.get("rows"),int) or indicator["rows"]<=0
            or any(len(str(indicator.get(k) or ""))!=64 or any(c not in "0123456789abcdef" for c in str(indicator.get(k)))
                   for k in ("formula_sha256","runner_sha256","input_sha256","output_sha256"))):
        raise ValueError("training_source_indicator_owner_binding_required")
    institutional=prep.get("institutional_capture") or {}
    fields=("foreign_net","trust_net","dealer_self_net","dealer_hedge_net")
    if (institutional.get("schema_version")!="training-institutional-capture-binding-v1"
            or institutional.get("capture_id")!=source["capture_id"]
            or len(str(institutional.get("actual_values_sha256") or ""))!=64
            or any(len(str(institutional.get("checksums",{}).get(k) or ""))!=64 for k in fields)):
        raise ValueError("training_source_institutional_binding_required")
    cap=prep.get("market_cap_capture") or {}
    if (cap.get("schema_version")!="training-market-cap-capture-binding-v1" or cap.get("capture_id")!=source["capture_id"]
            or any(len(str(cap.get(k) or ""))!=64 for k in ("market_value_sha256","actual_values_sha256"))):
        raise ValueError("training_source_market_cap_binding_required")
    auxiliary=prep.get("auxiliary_capture") or {}
    if (auxiliary.get("schema_version")!="training-auxiliary-capture-binding-v1"
            or auxiliary.get("capture_id")!=source["capture_id"]
            or len(str(auxiliary.get("capture_manifest_sha256") or ""))!=64):
        raise ValueError("training_source_auxiliary_binding_required")
    aux_raw=bucket.blob(auxiliary["capture_manifest_path"]).download_as_bytes()
    if hashlib.sha256(aux_raw).hexdigest()!=auxiliary["capture_manifest_sha256"]:
        raise ValueError("training_source_auxiliary_manifest_mismatch")
    aux_manifest=json.loads(aux_raw)
    from services.training_auxiliary_capture import FIELDS
    for name in FIELDS:
        expected=aux_manifest.get("fields",{}).get(name,{}).get("sha256")
        if not expected or auxiliary.get("fields",{}).get(name,{}).get("sha256")!=expected:
            raise ValueError("training_source_auxiliary_field_binding_required:"+name)
    long_source=prep.get("long_source_capture") or {}
    if long_source.get("schema_version")!="training-long-source-binding-v1" or long_source.get("capture_id")!=source["capture_id"]:
        raise ValueError("training_source_long_source_binding_required")
    for name in ("broker","holding"):
        proof=long_source.get(name) or {}
        raw=bucket.blob(proof["manifest_path"]).download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=proof.get("manifest_sha256"):
            raise ValueError("training_source_long_manifest_mismatch:"+name)
    global_capture=prep.get("global_capture") or {}
    if global_capture.get("schema_version")!="training-global-capture-binding-v1" or global_capture.get("capture_id")!=source["capture_id"]:
        raise ValueError("training_source_global_binding_required")
    from services.training_global_capture import read_market_history
    _,verified_global=read_market_history(bucket,price_capture=binding,us_component=global_capture.get("us_component") or {})
    if verified_global["history_sha256"]!=global_capture.get("history_sha256"):
        raise ValueError("training_source_global_history_mismatch")
    from services.training_session_calendar import verify_training_calendar
    calendar=verify_training_calendar(bucket,price_capture=binding)
    from services.training_feature_admission import require_feature_source_observations
    coverage=require_feature_source_observations(bucket, prep)
    return {"status":"verified_single_adjustment_capture", "capture_id":source["capture_id"],
            "prep_manifest_checksum":prep["manifest_checksum"],"sequence_manifest_checksum":sequence["manifest_checksum"],
            "feature_source_observations":coverage,"official_training_calendar":calendar,"all_root_sources_certified":False}



def require_oof_training_sources(bucket, manifest: dict) -> dict:
    """Admit every original fold source before reusing OOF for paid training.

    Artifact/provenance validity is checked by load_verified_oof_manifest;
    this adds the same data-quality gate used for new L3 dispatch. A later
    clean prep cannot certify an earlier fold's original inputs.
    """
    windows=manifest.get("windows")
    if not isinstance(windows,list) or not windows:
        raise ValueError("training_source_oof_windows_missing")
    inputs=[(manifest.get("prep_gcs_prefix"),manifest.get("sequence_gcs_prefix"),
             (manifest.get("prep_manifest") or {}).get("manifest_checksum"))]
    for window in windows:
        inputs.append((window.get("source_prep_gcs_prefix"),
                       window.get("source_sequence_gcs_prefix"),
                       window.get("source_prep_manifest_checksum")))
    from .formal_feature_contract import cohort_semantic, LEGACY_SEMANTIC
    semantic=cohort_semantic(manifest)
    verified={}
    for prep,sequence,expected in inputs:
        if (not isinstance(prep,str) or not prep or not isinstance(sequence,str) or not sequence
                or not isinstance(expected,str) or len(expected)!=64
                or any(c not in "0123456789abcdef" for c in expected)):
            raise ValueError("training_source_oof_input_identity_missing")
        key=(prep,sequence,expected)
        if key in verified:
            continue
        source_manifest=_sealed_manifest(bucket,prep,"manifest.json",compact=False)
        if source_manifest.get("feature_semantic_version",LEGACY_SEMANTIC)!=semantic:
            raise ValueError("training_source_oof_feature_semantic_mismatch")
        proof=require_single_adjustment_capture(bucket,prep_gcs_prefix=prep,sequence_gcs_prefix=sequence)
        if proof["prep_manifest_checksum"]!=expected:
            raise ValueError("training_source_oof_prep_checksum_mismatch")
        verified[key]=proof
    return {"status":"verified_oof_source_admission","folds":len(windows),
            "distinct_sources":len(verified),"all_root_sources_certified":False,
            "sources":[{"prep_gcs_prefix":p,"sequence_gcs_prefix":s,
                        "prep_manifest_checksum":c,"capture_id":proof["capture_id"]}
                       for (p,s,c),proof in verified.items()]}
