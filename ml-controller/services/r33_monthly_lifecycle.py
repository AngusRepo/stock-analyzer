"""R33 seven-model monthly candidate lifecycle, run inside the durable OOF Cloud Run job.

prep (job) -> fold OOF (Modal) -> D1 fold index -> OOF checks -> full-fit -> calibration
-> sealed candidate bundle. A failed check never dispatches full-fit. Full-fit trains
through the latest mature signal date, not the fold-aligned manifest end. Full-fit also
needs the capture's PIT vintage receipt, re-verified on every run, and carries it (C28-02).

Candidate-only: no P3 stacker/ensemble, no TabPack L4 refresh, no monthly L4 closure,
and never a write to model_champion_pointers or active8_ensemble_pointer_v1. The seven
registry rows wait for Wei with promotion_decision=r33_candidate_pending_wei.
"""
from __future__ import annotations

import hashlib
import io
import json
from typing import Any

OWNER = "r33_monthly_candidate"
PROMOTION_DECISION = "r33_candidate_pending_wei"
REGISTRY_STATUS = "r33_candidates_registered"
CHECKS_SCHEMA = "r33-monthly-oof-checks-receipt-v1"
BUNDLE_SCHEMA = "r33-monthly-candidate-bundle-v1"
BUNDLE_PREFIX = "r33/monthly_candidates"
# Same 18 bps round trip as the canonical prep (roundtrip_cost_bps); fit_calibration reports
# picks whose expected excess over the day's pool clears it.
ROUND_TRIP_COST = 0.0018
OOF_COLUMNS = ("prediction_date", "symbol", "market_segment", "model_name", "raw_score",
               "target_return", "label_known_date", "fold_id")


def _canonical(value: Any) -> str:
    def default(item):
        if hasattr(item, "item"):
            return item.item()
        if isinstance(item, (set, frozenset)):
            return sorted(item)
        raise TypeError(type(item).__name__)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), default=default, allow_nan=False)


def _read(blob) -> tuple[dict, str]:
    raw = blob.download_as_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def _write_once(blob, payload: dict) -> tuple[dict, str]:
    """Immutable GCS object; a concurrent writer's bytes win and are returned."""
    from google.api_core.exceptions import PreconditionFailed
    try:
        blob.upload_from_string(_canonical(payload), content_type="application/json", if_generation_match=0)
    except PreconditionFailed:
        pass
    return _read(blob)


def _select_sources(rows: list[dict], release_models) -> dict[str, dict]:
    from routers.walk_forward import _select_oof_full_fit_source_rows
    return _select_oof_full_fit_source_rows(rows, list(release_models))


def register_candidates(rows: list[dict], *, release_models, expected_run_id: str, upsert=None) -> dict:
    """Mark the seven full-fit rows as candidates awaiting Wei; no pointer is written."""
    if upsert is None:
        from services.model_artifact_registry import upsert_artifact_record as upsert
    sources = _select_sources(rows, release_models)
    errors = [
        name for name in release_models
        if name not in sources
        or str(sources[name].get("training_run_id") or "") != expected_run_id
        or str(sources[name].get("state") or "") in {"registration_failed", "rejected"}
        or not sources[name].get("artifact_path") or not sources[name].get("checksum")
    ]
    if errors:
        raise RuntimeError("r33_candidate_sources_invalid:" + ",".join(errors))
    artifacts = {}
    for name in release_models:
        row = {**sources[name], "promotion_decision": PROMOTION_DECISION, "approval_state": "required"}
        upsert(row)
        artifacts[name] = {key: row.get(key) for key in (
            "artifact_id", "version", "artifact_path", "metadata_path", "checksum", "state")}
    return {"status": REGISTRY_STATUS, "promotion_decision": PROMOTION_DECISION,
            "training_run_id": expected_run_id, "artifacts": artifacts, "ensemble_candidate": None}


def candidate_registry_complete(registry: dict | None, release_models) -> bool:
    registry = registry if isinstance(registry, dict) else {}
    artifacts = registry.get("artifacts") if isinstance(registry.get("artifacts"), dict) else {}
    return (registry.get("status") == REGISTRY_STATUS
            and registry.get("promotion_decision") == PROMOTION_DECISION
            and set(artifacts) == set(release_models)
            and all(item.get("artifact_id") and item.get("checksum") for item in artifacts.values()))


SEALED_CHECKS = ("leakage", "inversion", "tail_guard")


def _scope_values(node, key: str) -> list:
    """Every value stored under key anywhere in an artifact's metadata."""
    found, stack = [], [node]
    while stack:
        item = stack.pop()
        if isinstance(item, dict):
            if key in item:
                found.append(item[key])
            stack.extend(v for v in item.values() if isinstance(v, (dict, list)))
        elif isinstance(item, list):
            stack.extend(v for v in item if isinstance(v, (dict, list)))
    return found


def artifacts_missing_pit_binding(bucket, registry: dict, *, receipt_sha256: str, contract_version) -> list[str]:
    """Models whose full-fit metadata does not record this run's PIT receipt and contract version.

    The prep echoes the contract it applied; trainers do not. A trainer that dropped the
    fields (e.g. an older Modal image) would leave an artifact trained on lagged features
    that serving, seeing no version, would feed unlagged ones (C28-02 C2/C6).
    """
    missing = []
    for name, item in sorted((registry.get("artifacts") or {}).items()):
        path = str((item or {}).get("metadata_path") or "")
        try:
            blob = bucket.blob(path)
            meta = json.loads(blob.download_as_text()) if path and blob.exists() else None
        except (ValueError, TypeError):
            meta = None
        flags = _scope_values(meta, "point_in_time_vintage_certified")
        if (not isinstance(meta, dict) or not flags or any(flag is not True for flag in flags)
                or set(_scope_values(meta, "pit_certification_sha256")) != {receipt_sha256}
                or set(_scope_values(meta, "pit_contract_version")) != {contract_version}):
            missing.append(name)
    return missing


def _artifact_train_label_known_max(metadata: dict) -> str | None:
    split = metadata.get("split_metadata") if isinstance(metadata.get("split_metadata"), dict) else {}
    # Every R33 family writes an explicit attestation (TimeXer: its trainer report key).
    # A model without one (e.g. a pre-R33 NF artifact with only train_end) stays unattested.
    for key in ("train_label_known_max", "training_label_known_max"):
        if split.get(key):
            return str(split[key])[:10]
    return None


def fold_receipts(manifest: dict, bucket) -> list[dict]:
    """One receipt per fold whose every model attests the latest label it trained on.

    A fold with any unattested model is left out, so the leakage check fails it.
    """
    import numpy as np
    receipts = []
    for window in manifest.get("windows") or []:
        per_model = {}
        for name in manifest["model_set"]:
            metric = (window.get("model_metrics") or {}).get(name) or {}
            raw = bucket.blob(str(metric.get("oof_artifact") or "")).download_as_bytes()
            if hashlib.sha256(raw).hexdigest() != str(metric.get("artifact_checksum") or ""):
                raise ValueError(f"r33_fold_artifact_checksum_mismatch:w{window['window_id']}:{name}")
            metadata = json.loads(str(np.load(io.BytesIO(raw), allow_pickle=True)["metadata"].item()))
            per_model[name] = _artifact_train_label_known_max(metadata)
        if all(per_model.values()):
            receipts.append({"fold_id": f"w{window['window_id']}",
                             "test_start": str((window.get("test_range") or [None])[0])[:10],
                             "train_label_known_max": max(per_model.values()), "per_model": per_model})
    return receipts


def load_raw_open_close(bucket, sequence_gcs_prefix: str, *, start: str):
    """Raw (unadjusted) open/close from the cohort's sealed single price capture."""
    import polars as pl
    from services.training_source_preflight import _sealed_manifest
    sequence = _sealed_manifest(bucket, sequence_gcs_prefix, "sequence_manifest.json", compact=True)
    daily = [r for r in sequence.get("lane_reports", []) if r.get("lane") == "daily_price"]
    if len(daily) != 1 or not isinstance(daily[0].get("source_uri"), dict):
        raise ValueError("r33_price_capture_single_source_required")
    price_root = str(daily[0]["source_uri"].get("close") or "").split("/", 3)[3].rsplit("/", 1)[0]
    raw_manifest = bucket.blob(price_root + "/manifest.json").download_as_bytes()
    checksums = json.loads(raw_manifest).get("checksums") or {}
    frames = []
    for field in ("open", "close"):
        raw = bucket.blob(f"{price_root}/{field}.parquet").download_as_bytes()
        if hashlib.sha256(raw).hexdigest() != checksums.get(field):
            raise ValueError(f"r33_price_capture_checksum_mismatch:{field}")
        wide = (pl.read_parquet(io.BytesIO(raw)).with_columns(pl.col("date").cast(pl.String).str.slice(0, 10))
                .filter(pl.col("date") >= start))
        frames.append(wide.unpivot(index="date", variable_name="symbol", value_name=field)
                      .with_columns(pl.col(field).cast(pl.Float64, strict=False)))
    prices = (frames[0].join(frames[1], on=["date", "symbol"], how="inner")
              .filter(pl.col("open").is_finite() & pl.col("close").is_finite() & (pl.col("close") > 0)))
    return prices, {"price_capture_manifest": price_root + "/manifest.json",
                    "manifest_sha256": hashlib.sha256(raw_manifest).hexdigest(), "rows": prices.height}


def oof_frame(predictions: list[dict], limit_up):
    """Long OOF rows (date, symbol, model) with the entry-limit-up flag."""
    import polars as pl
    frame = pl.DataFrame({column: [row[column] for row in predictions] for column in OOF_COLUMNS})
    flags = limit_up.unique().with_columns(pl.lit(True).alias("entry_limit_up"))
    return (frame.join(flags, on=["prediction_date", "symbol"], how="left")
            .with_columns(pl.col("entry_limit_up").fill_null(False)))


def _coverage(index: dict, manifest: dict) -> dict:
    return {"date_count": index["prediction_dates"], "min_date": index["min_date"],
            "max_date": index["max_date"], "base_max_date": index["max_date"],
            "manifest_declared_end_date": manifest.get("end_date"),
            "declared_end_matches_physical": index["max_date"] == manifest.get("end_date")}


async def run_r33_monthly_lifecycle(*, manifest_path: str, cohort_id: str, as_of: str, cadence: str,
                                    calendar: dict | None, dry_run: bool, poll_only: bool, bucket, client,
                                    ops_query=None) -> dict:
    base = {"materialization_owner": OWNER, "cadence": cadence, "cohort_id": cohort_id,
            "knowledge_cutoff_date": as_of, "calendar": calendar or {}, "promoted": False,
            "promotion_allowed": False, "serving_pointer_changed": False}
    if cadence != "monthly":
        return {**base, "status": "skipped", "reason": "r33_cohort_monthly_owner_only",
                "training_dispatched": False}
    from services.active8_oof_cohort_materializer import load_oof_prediction_rows, load_verified_oof_manifest
    from services.alpha_model_roster import R33_MODELS
    from services.l4_oof_index_receipt import reuse_index, seal_index
    from services.l4_oof_lifecycle import persist_base_index
    from services.training_source_preflight import require_oof_training_sources
    from routers.walk_forward import R33_OOF_TEST_SESSIONS, dispatch_oof_full_fit_training
    from services import r33_calibration_job, r33_oof_checks
    from services.pit_certification import verify_bound_receipt

    manifest, _ = load_verified_oof_manifest(manifest_path, bucket=bucket, require_formal_lineage=True)
    if (manifest["cohort_id"] != cohort_id or tuple(manifest.get("model_set") or ()) != R33_MODELS
            or int(manifest.get("test_window_days") or 0) != R33_OOF_TEST_SESSIONS):
        raise ValueError("r33_manifest_contract_invalid")
    require_oof_training_sources(bucket, manifest)

    loaded: dict[str, Any] = {}

    def predictions() -> list[dict]:
        if "predictions" not in loaded:
            loaded["predictions"] = load_oof_prediction_rows(manifest, bucket=bucket)
        return loaded["predictions"]

    def inputs() -> dict:
        # Loaded at most once per job and only when a step still needs the OOF rows.
        if "oof" not in loaded:
            dates = sorted({row["prediction_date"] for row in predictions()})
            prices, price_receipt = load_raw_open_close(bucket, manifest["sequence_gcs_prefix"], start=dates[0])
            if ops_query is None:
                from services.d1_domain_client import D1DataDomain, client_proxy_for_domain
                query = client_proxy_for_domain(D1DataDomain.OPS).query
            else:
                query = ops_query
            pool, pool_receipt = r33_calibration_job.load_l2_pool(query, start=dates[0], end=dates[-1])
            loaded.update(pool=pool, pool_receipt=pool_receipt, price_receipt=price_receipt,
                          oof=oof_frame(predictions(), r33_oof_checks.entry_limit_up_rows(prices)))
        return loaded

    index = None if dry_run else reuse_index(manifest, bucket, client)
    if index is None:
        index = persist_base_index(manifest=manifest, predictions=predictions(),
                                   client=client, dry_run=dry_run)
        if not dry_run:
            seal_index(manifest, index, bucket, client)
    base.update(persistence=index, physical_prediction_coverage=_coverage(index, manifest))
    if dry_run:
        return {**base, "status": "dry_run"}

    prefix = f"{BUNDLE_PREFIX}/{cohort_id}"
    checks_blob = bucket.blob(prefix + "/oof_checks.json")
    # The receipt must sit next to this capture and cover every prep the cohort trained on:
    # the full-fit prep and each window's source prep (a recovered pre-contract window fails).
    try:
        pit = verify_bound_receipt(bucket, sequence_gcs_prefix=manifest["sequence_gcs_prefix"],
                                   prep_gcs_prefixes=[manifest.get("prep_gcs_prefix"),
                                                      *[w.get("source_prep_gcs_prefix") for w in manifest.get("windows") or []]])
    except (ValueError, TypeError, KeyError, AttributeError) as exc:
        # An unreadable stored receipt fails the gate; GCS transport errors still propagate (retry).
        # The message names which input failed (contract file, capture root, sequence manifest).
        pit = {"certified": False, "attached": None,
               "reasons": [f"receipt_unreadable:{type(exc).__name__}:{str(exc)[:200]}"]}
    if checks_blob.exists():
        report, checks_checksum = _read(checks_blob)
    else:
        data = inputs()
        receipts = fold_receipts(manifest, bucket)
        report = {"schema_version": CHECKS_SCHEMA, "cohort_id": cohort_id,
                  "manifest_checksum": manifest["manifest_checksum"], "knowledge_cutoff_date": as_of,
                  "fold_receipts": receipts, "pool": data["pool_receipt"], "prices": data["price_receipt"],
                  "result": r33_oof_checks.run_checks(
                      oof=data["oof"], fold_receipts=receipts, pool_by_date=data["pool"], new_fold_from=None,
                      pit_certification=pit["attached"], pit_binding_reasons=pit.get("binding_reasons") or ())}
        report, checks_checksum = _write_once(checks_blob, report)
    if report.get("manifest_checksum") != manifest["manifest_checksum"]:
        raise ValueError("r33_oof_checks_manifest_mismatch")
    # The sealed OOF checks are write-once; their pit_vintage entry is the result at seal time.
    # The PIT gate is re-verified on every run, so a receipt uploaded or regenerated later
    # is judged freshly while leakage/inversion/tail-guard can never be re-rolled.
    sealed = report["result"].get("checks") or {}
    sealed_pass = all((sealed.get(k) or {}).get("passed") is True for k in SEALED_CHECKS)
    # status is the gate this run applied (sealed non-PIT checks + this run's PIT verification);
    # sealed_status is the file's own status, whose pit_vintage may predate the current receipt.
    checks = {"path": checks_blob.name, "checksum": checks_checksum,
              "status": "pass" if sealed_pass and pit["certified"] else "fail",
              "sealed_status": report["result"].get("status"), "pit_certified": pit["certified"],
              "pit_certification_sha256": pit.get("receipt_sha256")}
    if not sealed_pass:
        return {**base, "status": "failed", "reason": "r33_oof_checks_failed", "r33_oof_checks": checks,
                "full_fit_dispatch": {"status": "not_dispatched", "reason": "r33_oof_checks_failed"},
                "training_dispatched": False}
    pit_certification = pit["attached"]
    if not pit["certified"]:
        return {**base, "status": "failed", "reason": "r33_pit_certification_unbound", "r33_oof_checks": checks,
                "pit_certification": {k: pit.get(k) for k in ("certified", "reasons", "receipt_sha256")},
                "full_fit_dispatch": {"status": "not_dispatched", "reason": "r33_pit_certification_unbound"},
                "training_dispatched": False}

    # Wei: the full-fit learns through the latest mature signal, not the fold-aligned end.
    # No fallback: a missing mature watermark must not silently train through end_date.
    signal_date_max = str((calendar or {}).get("mature_max_date") or "")[:10]
    if len(signal_date_max) != 10:
        return {**base, "status": "failed", "reason": "r33_mature_max_date_missing", "r33_oof_checks": checks,
                "full_fit_dispatch": {"status": "not_dispatched", "reason": "r33_mature_max_date_missing"},
                "training_dispatched": False}
    full_fit = await dispatch_oof_full_fit_training(
        manifest=manifest, knowledge_cutoff_date=as_of, bucket=bucket, lifecycle_cadence=cadence,
        allow_new_dispatch=not poll_only, signal_date_max=signal_date_max, candidate_only=True,
        pit_certification=pit_certification)
    summary = {**full_fit, "signal_date_max": signal_date_max}  # continuation_limit reads modal_poll/dispatch.
    if full_fit.get("retry_required"):
        return {**base, "status": "pending", "dependency_retry_required": True, "r33_oof_checks": checks,
                "reason": full_fit.get("reason") or "r33_full_fit_pending", "full_fit_dispatch": summary}
    registry = full_fit.get("release_registry")
    if full_fit.get("status") != "completed" or not candidate_registry_complete(registry, R33_MODELS):
        return {**base, "status": "failed", "reason": full_fit.get("reason") or "r33_full_fit_incomplete",
                "r33_oof_checks": checks, "full_fit_dispatch": summary}
    unbound = artifacts_missing_pit_binding(bucket, registry, receipt_sha256=pit["receipt_sha256"],
                                            contract_version=pit_certification["receipt"].get("contract_version"))
    if unbound:
        return {**base, "status": "failed", "reason": "r33_full_fit_pit_metadata_missing", "r33_oof_checks": checks,
                "full_fit_dispatch": {**summary, "pit_metadata_missing": unbound}}

    bundle_blob = bucket.blob(prefix + "/bundle.json")
    if bundle_blob.exists():
        bundle, bundle_checksum = _read(bundle_blob)
    else:
        data = inputs()
        # A15: the isotonic minimum block weight is a declared contract parameter. Its single
        # owner is r33_calibration_job.MIN_BLOCK_DAYS (the OOF checks' crossfit reads the same).
        min_block_days = float(r33_calibration_job.MIN_BLOCK_DAYS)
        calibration = r33_calibration_job.fit_calibration(
            oof=data["oof"], pool_by_date=data["pool"], round_trip_cost=ROUND_TRIP_COST,
            min_block_weight=min_block_days,
            inputs={"cohort_id": cohort_id, "manifest_checksum": manifest["manifest_checksum"],
                    "oof_checks_checksum": checks_checksum, "pool": data["pool_receipt"],
                    "prices": data["price_receipt"]})
        bundle, bundle_checksum = _write_once(bundle_blob, {
            "schema_version": BUNDLE_SCHEMA, "status": "sealed", "cohort_id": cohort_id,
            "manifest_path": manifest_path, "manifest_checksum": manifest["manifest_checksum"],
            "knowledge_cutoff_date": as_of, "full_fit_signal_date_max": signal_date_max,
            "mature_max_date": signal_date_max,
            "training_run_id": registry["training_run_id"], "promotion_decision": PROMOTION_DECISION,
            "artifacts": registry["artifacts"], "calibration": calibration, "oof_checks": checks,
            "calibration_contract": {"min_block_days": min_block_days,
                                     "owner": "services.r33_calibration_job.MIN_BLOCK_DAYS",
                                     "round_trip_cost": ROUND_TRIP_COST},
            "serving_pointer_changed": False})
    if (bundle.get("schema_version") != BUNDLE_SCHEMA or bundle.get("manifest_checksum") != manifest["manifest_checksum"]
            or bundle.get("artifacts") != registry["artifacts"]
            or bundle.get("full_fit_signal_date_max") != signal_date_max):
        raise ValueError("r33_candidate_bundle_readback_mismatch")
    return {**base, "status": "materialized", "r33_oof_checks": checks, "full_fit_dispatch": summary,
            "r33_candidate_bundle": {"status": "sealed", "path": bundle_blob.name, "checksum": bundle_checksum,
                                     "artifact_ids": [item["artifact_id"] for item in bundle["artifacts"].values()]}}
