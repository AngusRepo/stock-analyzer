"""C28-02 P2 T1: PIT-lagged TimeXer daily sources, built by the same feature-only prep.

The legacy daily prep stays the capture owner. When a PIT-trained TimeXer will be served,
every prep batch also writes a lagged copy of the same payloads under
`<legacy prefix>-pit-<version>`, sealed by its own receipt that names the legacy receipt.
A variant failure only removes that version's source; the legacy prep is never affected.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone

STATE_SCHEMA = "timexer-pit-feature-sources-v1"
# Everything that identifies the capture and recipe; a variant must equal its legacy prep here.
CAPTURE_KEYS = ("schema_version", "business_date", "producer_source_sha", "feature_semantic_version",
                "feature_imputation_semantic", "price_capture", "institutional_capture",
                "market_cap_capture", "auxiliary_capture", "long_source_capture", "global_capture")
_REPLACED = ("output_gcs_prefix", "output_checksums", "batch_rows", "output_rows", "batch_count",
             "feature_names_path", "receipt_checksum", "created_at")


def _sha(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def _checksum(receipt: dict) -> str:
    return _sha(json.dumps({k: v for k, v in receipt.items() if k != "receipt_checksum"},
                           sort_keys=True).encode("utf-8"))


def variant_prefix(prefix: str, version: str) -> str:
    return f"{str(prefix).rstrip('/')}-pit-{version}"


def variant_specs(prefix: str, versions) -> list[dict]:
    from services.pit_certification import CONTRACT_VERSION, contract_content_sha256, load_contract
    specs = []
    for version in sorted(set(versions or ())):
        if version != CONTRACT_VERSION:
            raise ValueError("pit_variant_version_unknown")
        specs.append({"gcs_prefix": variant_prefix(prefix, version), "pit_contract_version": version,
                      "pit_contract_sha256": contract_content_sha256(load_contract())})
    return specs


def _metadata_version(metadata) -> str | None:
    from services.r33_monthly_lifecycle import _scope_values
    found = set(_scope_values(metadata, "pit_contract_version"))
    if len(found) > 1:
        raise ValueError("pit_contract_version_ambiguous")
    return next(iter(found), None)


def required_versions(state: dict, *, query, bucket_factory) -> list[str]:
    """PIT contract versions of every TimeXer artifact this run may serve.

    Reads the frozen serving manifest and the NAV candidate ensembles the L2 dispatch
    will select (same filter as paired_nav_l3_dispatch.prepare_candidate_requests).
    Registered NAV pins are not read; a pinned PIT TimeXer outside them fails closed.
    """
    manifest = (state.get("pipeline_modal_serving_context") or {}).get("serving_manifest") or {}
    paths = set()
    for section in ("models", "active8_shadow_candidates"):
        rows = manifest.get(section) or []
        for row in (rows.values() if isinstance(rows, dict) else rows):
            if isinstance(row, dict) and row.get("model") == "TimeXer" and row.get("metadata_path"):
                paths.add(str(row["metadata_path"]))
    from services.paper_strategy_mode import from_manifest
    if isinstance(manifest.get("active8_ensemble"), dict) and not from_manifest(manifest, signal_date=state["run_date"]):
        rows = query("SELECT payload_json FROM active8_ensemble_artifacts_v1 WHERE state='candidate' "
                     "AND production_effect=0 AND julianday(created_at)<=julianday(?) "
                     "AND knowledge_cutoff_date<=?", [state["decision_universe_frozen_at"], state["run_date"]])
        ids = sorted({str(((json.loads(row["payload_json"]).get("observation_artifacts") or {})
                           .get("TimeXer") or {}).get("artifact_id") or "") for row in rows} - {""})
        if ids:
            registry = query("SELECT artifact_id, metadata_path FROM model_artifact_registry WHERE artifact_id IN ("
                             + ",".join("?" for _ in ids) + ")", ids)
            if len(registry) != len(ids) or any(not row.get("metadata_path") for row in registry):
                raise ValueError("pit_daily_candidate_registry_missing")
            paths.update(str(row["metadata_path"]) for row in registry)
    versions = set()
    bucket = bucket_factory() if paths else None  # legacy-only manifests touch no GCS
    for path in sorted(paths):
        version = _metadata_version(json.loads(bucket.blob(path).download_as_bytes()))
        if version is not None:
            versions.add(version)
    return sorted(versions)


def seal_variants(bucket, *, legacy_receipt: dict, results: list, specs: list[dict]) -> dict:
    """Seal each variant whose every batch reported its own contract; returns prefix -> status.

    Called after the legacy receipt is sealed. Callers keep exceptions from reaching the
    legacy prep; a variant left unsealed only fails that version's TimeXer closed.
    """
    from google.api_core.exceptions import PreconditionFailed
    status = {}
    for spec in specs or ():
        prefix = spec["gcs_prefix"]
        reports = [((result or {}).get("pit_variants") or {}).get(prefix) or {} for result in results or ()]
        if (not reports or any(report.get("error") or int(report.get("rows") or 0) <= 0
                               or report.get("pit_contract_version") != spec["pit_contract_version"]
                               or report.get("pit_contract_sha256") != spec["pit_contract_sha256"]
                               for report in reports)):
            status[prefix] = {"status": "not_sealed", "reason": "pit_variant_batches_incomplete",
                              "errors": sorted({str(r.get("error"))[:200] for r in reports if r.get("error")})[:5]}
            continue
        paths = [f"{prefix}/prep/batch_{index}.npz" for index in range(len(reports))]
        names_path = f"{prefix}/prep/feature_names.json"
        checksums = {path: _sha(bucket.blob(path).download_as_bytes()) for path in [*paths, names_path]}
        legacy_names = legacy_receipt["feature_names_path"]
        if checksums[names_path] != (legacy_receipt.get("output_checksums") or {}).get(legacy_names):
            status[prefix] = {"status": "not_sealed", "reason": "pit_variant_feature_names_mismatch"}
            continue
        rows = [int(report["rows"]) for report in reports]
        receipt = {**{k: v for k, v in legacy_receipt.items() if k not in _REPLACED},
                   "created_at": datetime.now(timezone.utc).isoformat(), "output_gcs_prefix": prefix,
                   "batch_count": len(rows), "batch_rows": rows, "output_rows": sum(rows),
                   "output_checksums": checksums, "feature_names_path": names_path,
                   "pit_contract_version": spec["pit_contract_version"],
                   "pit_contract_sha256": spec["pit_contract_sha256"],
                   "pit_variant_of": legacy_receipt["receipt_checksum"]}
        receipt["receipt_checksum"] = _checksum(receipt)
        try:
            bucket.blob(f"{prefix}/prep/immutable_receipt.json").upload_from_string(
                json.dumps(receipt, sort_keys=True, indent=2), content_type="application/json",
                if_generation_match=0)
            status[prefix] = {"status": "sealed", "receipt_checksum": receipt["receipt_checksum"]}
        except PreconditionFailed:
            status[prefix] = {"status": "already_sealed"}
    return status


def variant_sources(bucket, legacy_source: dict, versions) -> dict:
    """State value for timexer_pit_feature_sources: verified sources and per-version failures."""
    from services.pit_certification import contract_content_sha256, load_contract
    sources, failures = {}, {}
    try:
        legacy_prefix = str(legacy_source["source_gcs_prefix"]).rstrip("/")
        legacy = json.loads(bucket.blob(f"{legacy_prefix}/prep/immutable_receipt.json").download_as_bytes())
        if (legacy.get("receipt_checksum") != _checksum(legacy)
                or legacy.get("receipt_checksum") != legacy_source.get("source_receipt_checksum")):
            raise ValueError("pit_variant_legacy_receipt_invalid")
    except Exception as exc:  # noqa: BLE001
        return {"schema_version": STATE_SCHEMA, "required_versions": sorted(versions), "sources": {},
                "failures": {v: f"{type(exc).__name__}: {exc}"[:300] for v in versions}}
    expected_sha = contract_content_sha256(load_contract())
    for version in sorted(versions):
        prefix = variant_prefix(legacy_prefix, version)
        try:
            blob = bucket.blob(f"{prefix}/prep/immutable_receipt.json")
            if not blob.exists():
                raise ValueError("pit_variant_receipt_missing")
            receipt = json.loads(blob.download_as_bytes())
            count = receipt.get("batch_count")
            inventory = {f"{prefix}/prep/batch_{i}.npz" for i in range(count)} if isinstance(count, int) and count > 0 else set()
            if (receipt.get("receipt_checksum") != _checksum(receipt) or receipt.get("status") != "ready"
                    or receipt.get("output_gcs_prefix") != prefix or receipt.get("training_dispatched") is not False
                    or not inventory or set(receipt.get("output_checksums") or {}) != inventory | {f"{prefix}/prep/feature_names.json"}):
                raise ValueError("pit_variant_receipt_invalid")
            if receipt.get("pit_contract_version") != version or receipt.get("pit_contract_sha256") != expected_sha:
                raise ValueError("pit_variant_contract_mismatch")
            names = receipt["output_checksums"][f"{prefix}/prep/feature_names.json"]
            if (receipt.get("pit_variant_of") != legacy["receipt_checksum"]
                    or any(receipt.get(key) != legacy.get(key) for key in CAPTURE_KEYS)
                    or names != (legacy.get("output_checksums") or {}).get(legacy.get("feature_names_path"))):
                raise ValueError("pit_variant_capture_mismatch")
            sources[version] = {**legacy_source, "source_gcs_prefix": prefix,
                                "source_receipt_checksum": receipt["receipt_checksum"],
                                "pit_contract_version": version}
        except Exception as exc:  # noqa: BLE001 - only this version's TimeXer fails closed.
            failures[version] = f"{type(exc).__name__}: {exc}"[:300]
    return {"schema_version": STATE_SCHEMA, "required_versions": sorted(versions),
            "sources": sources, "failures": failures}
