"""Derive point_in_time_vintage_certified from evidence (C28-02 C5).

Only this module computes the flag. Inputs: the Wei-approved availability contract,
the capture's sealed lane manifests (capture inventory) and the T1/T2/T4/T5 results
recorded for that capture. Any gap yields false with reasons; nothing is hand-set.
The receipt never claims that 2020-05..2026-05 publication timestamps are proven.
"""
from __future__ import annotations

import hashlib
import json
from datetime import datetime, timezone
from pathlib import Path

SCHEMA = "pit-vintage-certification-v1"
CONTRACT_VERSION = "pit-availability-contract-v1"
CONTRACT_FILE = "pit_availability_contract_v1.json"
RECEIPT_FILE = "pit_certification.json"
APPROVAL_KEYS = ("approved_by", "approved_at", "approved_content_sha256", "approval_status")
LEVELS = frozenset({"V", "O", "R", "I", "N/A"})
# Sources outside the 131 feature columns that the flag still covers (plan §1.4).
NON_FEATURE_DATASETS = ("label", "universe")
REQUIRED_TESTS = {
    "T1": "ml-controller/tests/test_pit_truncation_equivalence.py",
    "T2": "ml-service/tests/test_pit_lag_contract.py",
    "T4": "ml-service/tests/test_sequence_scale_invariance.py",
    "T5": "ml-controller/tests/test_pit_revision_fixture.py",
}
# The six capture lanes (docs/R33_MONTHLY_LIFECYCLE.md) and what binds each one.
LANE_MANIFESTS = {
    "daily_price": "/daily_price_full_vintage/manifest.json",
    "chip_diversity": "/chip_diversity_full_vintage/manifest.json",
    "broker_flow_diversity": "/training_long_full_vintage/broker.json",
    "training_shareholding": "/training_long_full_vintage/holding.json",
}
LANE_AUXILIARY_FIELDS = {
    "chip_diversity": ("margin_balance", "short_balance"),
    "revenue": ("revenue", "revenue_yoy", "revenue_mom"),
    "fundamental_factor_diversity": ("eps", "roe", "pe", "pb", "dividend_yield", "revenue_growth_yoy"),
}
# training_auxiliary_capture field -> contract dataset that owns its level.
AUXILIARY_FIELD_DATASETS = {
    "margin_balance": "margin_short", "short_balance": "margin_short",
    "pe": "valuation", "pb": "valuation", "dividend_yield": "valuation",
    "revenue": "monthly_revenue", "revenue_yoy": "monthly_revenue", "revenue_mom": "monthly_revenue",
    "eps": "eps", "roe": "roe", "revenue_growth_yoy": "revenue_growth_yoy",
}
LANES = ("daily_price", "chip_diversity", "revenue", "fundamental_factor_diversity",
         "training_shareholding", "broker_flow_diversity")
# Feature-layer columns that carry each dataset's lag. A dataset with lag_sessions > 0 must
# be listed here with every column in feature_lags, or the declared lag would not be applied.
DATASET_LAG_COLUMNS = {
    "margin_short": ("margin_balance", "short_balance", "short_ratio"),
    "monthly_revenue": ("revenue", "revenue_yoy", "revenue_mom"),
    "eps": ("eps",), "roe": ("roe",), "revenue_growth_yoy": ("revenue_growth_yoy",),
    "valuation": ("pe", "pb", "dividend_yield"),
    "broker": ("broker_net_shares", "broker_estimated_amount", "broker_concentration", "broker_count"),
}
ROSTER_SIDECAR_SCHEMA = "training-roster-capture-sidecar-v1"
HISTORY_LIMITATION = ("Original publication timestamps for 2020-05..2026-05 are not proven: no archived "
                      "vintage exists for that period and neither FinLab nor TWSE provides them.")
REPO = Path(__file__).resolve().parents[2]


def canonical_sha256(value) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def contract_content_sha256(contract: dict) -> str:
    """What Wei approves: every key except the approval record itself."""
    return canonical_sha256({k: v for k, v in contract.items() if k not in APPROVAL_KEYS})


def contract_approved(contract: dict) -> bool:
    by, at = contract.get("approved_by"), contract.get("approved_at")
    if not isinstance(by, str) or not by.strip() or not isinstance(at, str):
        return False
    try:
        datetime.fromisoformat(at)
    except ValueError:
        return False
    return (contract.get("approval_status") == "approved"
            and contract.get("approved_content_sha256") == contract_content_sha256(contract))


def registry_path(filename: str) -> Path:
    for path in (Path("/app/data/feature_registry") / filename, REPO / "data" / "feature_registry" / filename):
        if path.exists():
            return path
    raise ValueError("pit_registry_file_missing:" + filename)


def load_contract() -> dict:
    contract = json.loads(registry_path(CONTRACT_FILE).read_text(encoding="utf-8"))
    if contract.get("contract_version") != CONTRACT_VERSION:
        raise ValueError("pit_contract_version_mismatch")
    return contract


def file_sha256(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def revised_quarter_cells(old, new, *, rel_tol=1e-6, abs_tol=1e-9) -> dict:
    """Symbol x quarter cells whose value changed between two sealed financial vintages.

    A whole-series constant-factor rebase is a revision too: every changed cell is
    listed; rebase_symbols only labels which symbols changed by one constant ratio.
    """
    import polars as pl
    from services.finlab_sealed_raw import quarterly_index

    def long(frame):
        return (quarterly_index(frame).unpivot(index="date", variable_name="symbol", value_name="value")
                .drop_nulls("value").filter(pl.col("value").cast(pl.Float64).is_finite())
                .rename({"date": "quarter"}))

    joined = long(old).join(long(new), on=["quarter", "symbol"], suffix="_new")
    changed = joined.filter((pl.col("value") - pl.col("value_new")).abs()
                            > abs_tol + rel_tol * pl.col("value_new").abs())
    symbols = sorted(set(changed["symbol"].to_list()))
    ratios = (joined.filter(pl.col("symbol").is_in(symbols) & (pl.col("value") != 0))
              .group_by("symbol").agg((pl.col("value_new") / pl.col("value")).min().alias("lo"),
                                      (pl.col("value_new") / pl.col("value")).max().alias("hi")))
    rebase = sorted(r["symbol"] for r in ratios.iter_rows(named=True)
                    if abs(r["hi"] - r["lo"]) <= rel_tol * abs(r["lo"]))
    return {"overlap_cells": joined.height, "changed_cells": changed.height, "symbols": len(symbols),
            "rebase_symbols": rebase,
            "cells": sorted([r["symbol"], r["quarter"]] for r in changed.iter_rows(named=True))}


def load_revision_mask(contract: dict, field: str) -> dict:
    spec = (contract.get("revision_masks") or {}).get(field)
    if not isinstance(spec, dict):
        raise ValueError("pit_revision_mask_undeclared:" + field)
    path = registry_path(spec["file"])
    if file_sha256(path) != spec.get("sha256"):
        raise ValueError("pit_revision_mask_checksum_mismatch:" + field)
    mask = json.loads(path.read_text(encoding="utf-8"))
    if mask.get("field") != field or not isinstance(mask.get("cells"), list):
        raise ValueError("pit_revision_mask_invalid:" + field)
    return {"sha256": spec["sha256"], "file": spec["file"],
            "cells": frozenset((str(s), str(q)) for s, q in mask["cells"])}


def test_results_from_junit(paths) -> dict:
    """Per required test id: counts from junit XML plus the test file's current sha256."""
    import xml.etree.ElementTree as ET
    found = {key: {"tests": 0, "failures": 0, "errors": 0, "skipped": 0} for key in REQUIRED_TESTS}
    junit = {}
    for path in paths:
        junit[str(path)] = file_sha256(path)
        for case in ET.parse(path).getroot().iter("testcase"):
            source = (case.get("file") or case.get("classname") or "").replace(".", "/")
            for key, rel in REQUIRED_TESTS.items():
                if Path(rel).stem in source:
                    found[key]["tests"] += 1
                    for tag, name in (("failure", "failures"), ("error", "errors"), ("skipped", "skipped")):
                        found[key][name] += len(case.findall(tag))
    results = {}
    for key, rel in REQUIRED_TESTS.items():
        counts = found[key]
        bad = counts["failures"] + counts["errors"] + counts["skipped"]
        results[key] = {**counts, "file": rel, "file_sha256": file_sha256(REPO / rel) if (REPO / rel).exists() else None,
                        "status": "missing" if not counts["tests"] else "failed" if bad else "passed"}
    return {"junit_sha256": junit, "results": results}


def _lanes(inventory: dict) -> dict:
    manifests = inventory.get("manifest_sha256") or {}
    auxiliary = inventory.get("auxiliary_field_captures") or {}
    lanes = {}
    for lane in LANES:
        entry = {}
        suffix = LANE_MANIFESTS.get(lane)
        if suffix:
            entry["manifests"] = {p: s for p, s in manifests.items() if p.endswith(suffix)}
        fields = LANE_AUXILIARY_FIELDS.get(lane, ())
        if fields:
            entry["auxiliary_fields"] = {f: auxiliary.get(f) for f in fields}
        lanes[lane] = entry
    return lanes


def derive(receipt: dict, contract: dict) -> tuple[bool, list[str]]:
    """Recompute the flag from a receipt's recorded evidence and the current contract."""
    from services.formal_feature_contract import FEATURES131
    reasons = []
    if receipt.get("schema_version") != SCHEMA:
        reasons.append("receipt_schema_invalid")
    if contract.get("contract_version") != CONTRACT_VERSION or receipt.get("contract_version") != CONTRACT_VERSION:
        reasons.append("contract_version_mismatch")
    if receipt.get("contract_sha256") != contract_content_sha256(contract):
        reasons.append("contract_sha256_mismatch")
    if not contract_approved(contract):
        reasons.append("contract_not_approved")
    capture = receipt.get("capture") or {}
    if not capture.get("capture_id") or capture.get("inventory_status") != "inventory_ready":
        reasons.append("capture_inventory_not_ready")
    for lane in LANES:
        entry = (receipt.get("lanes") or {}).get(lane) or {}
        manifests = entry.get("manifests")
        if LANE_MANIFESTS.get(lane) and (len(manifests or {}) != 1
                                         or not all(_is_sha(v) for v in manifests.values())):
            reasons.append("lane_manifest_unbound:" + lane)
        for field, binding in (entry.get("auxiliary_fields") or {}).items():
            if not isinstance(binding, dict) or not _is_sha(binding.get("capture_manifest_sha256")):
                reasons.append(f"lane_field_unbound:{lane}:{field}")
        if LANE_AUXILIARY_FIELDS.get(lane) and set(entry.get("auxiliary_fields") or {}) != set(LANE_AUXILIARY_FIELDS[lane]):
            reasons.append("lane_fields_incomplete:" + lane)
    datasets = contract.get("datasets") or {}
    owner = {}
    for name, spec in datasets.items():
        if (spec or {}).get("level") not in LEVELS:
            reasons.append("dataset_level_uncertified:" + name)
        if (spec or {}).get("level") == "N/A" and (spec or {}).get("features"):
            # N/A means "not a model input"; a dataset feeding features needs a real level.
            reasons.append("dataset_not_applicable_owns_features:" + name)
        for feature in (spec or {}).get("features") or ():
            if feature in owner:
                reasons.append("feature_level_duplicate:" + feature)
            owner[feature] = name
    for name in NON_FEATURE_DATASETS:
        if name not in datasets:
            reasons.append("dataset_level_missing:" + name)
    # feature_lags is what the feature layer applies; it must say what each dataset declares.
    lags = contract.get("feature_lags") or {}
    for name, spec in datasets.items():
        lag = (spec or {}).get("lag_sessions") or 0
        columns = DATASET_LAG_COLUMNS.get(name)
        if columns is None:
            if lag:
                reasons.append("dataset_lag_unowned:" + name)
            continue
        reasons += ["feature_lag_mismatch:" + c for c in columns if lags.get(c, 0) != lag]
    owned = {c for columns in DATASET_LAG_COLUMNS.values() for c in columns}
    reasons += ["feature_lag_undeclared:" + c for c in sorted(set(lags) - owned)]
    reasons += ["feature_level_missing:" + f for f in FEATURES131 if f not in owner]
    reasons += ["feature_level_unknown:" + f for f in sorted(set(owner) - set(FEATURES131))]
    # Each recorded file must be the one the contract names, by sha256, not only "verified".
    for group, label in (("evidence", "evidence"), ("revision_masks", "revision_mask")):
        recorded, declared = receipt.get(group) or {}, contract.get(group) or {}
        if not isinstance(recorded, dict) or not isinstance(declared, dict):
            reasons.append(f"{group}_invalid")
            continue
        for name, item in recorded.items():
            item = item if isinstance(item, dict) else {}
            if not item.get("verified"):
                reasons.append(f"{label}_unverified:{name}")
            elif item.get("sha256") != (declared.get(name) or {}).get("sha256"):
                reasons.append(f"{label}_sha256_mismatch:{name}")
        if set(recorded) != set(declared):
            reasons.append("evidence_incomplete" if group == "evidence" else "revision_masks_incomplete")
    tests = (receipt.get("tests") or {}).get("results") or {}
    # The approved contract pins each test file and its case count: an edited, weakened or
    # partially selected (-k) run is not the test Wei approved.
    required = contract.get("required_tests") or {}
    if not isinstance(required, dict) or sorted(required) != sorted(REQUIRED_TESTS):
        reasons.append("required_tests_mismatch")
        required = {}
    for key in REQUIRED_TESTS:
        result, pinned = tests.get(key) or {}, required.get(key) or {}
        if (result.get("status") != "passed" or not _is_sha(result.get("file_sha256"))
                or any(result.get(k) != 0 for k in ("failures", "errors", "skipped"))):
            reasons.append(f"test_not_passed:{key}:{result.get('status', 'missing')}")
        elif (pinned.get("file") != REQUIRED_TESTS[key] or result.get("file_sha256") != pinned.get("sha256")
              or result.get("tests") != pinned.get("cases")):
            reasons.append(f"test_not_pinned:{key}")
    recorded = receipt.get("limitations")
    recorded = recorded if isinstance(recorded, list) else []  # a string would match substrings
    if HISTORY_LIMITATION not in recorded:
        reasons.append("history_limitation_missing")
    if any(item not in recorded for item in contract.get("limitations") or []):
        reasons.append("contract_limitation_missing")
    return not reasons, reasons


def _is_sha(value) -> bool:
    return isinstance(value, str) and len(value) == 64 and all(c in "0123456789abcdef" for c in value)


def certify(*, contract: dict, inventory: dict, tests: dict, generated_at: str | None = None) -> dict:
    evidence = {}
    for name, spec in (contract.get("evidence") or {}).items():
        path = REPO / spec["path"]
        actual = file_sha256(path) if path.exists() else None
        evidence[name] = {"path": spec["path"], "sha256": spec.get("sha256"), "verified": actual == spec.get("sha256")}
    masks = {}
    for field, spec in (contract.get("revision_masks") or {}).items():
        try:
            loaded = load_revision_mask(contract, field)
            masks[field] = {"file": loaded["file"], "sha256": loaded["sha256"], "cells": len(loaded["cells"]), "verified": True}
        except (ValueError, KeyError, OSError) as exc:
            masks[field] = {"file": (spec or {}).get("file"), "verified": False, "detail": str(exc)}
    receipt = {
        "schema_version": SCHEMA,
        "contract_version": contract.get("contract_version"),
        "contract_sha256": contract_content_sha256(contract),
        "contract_approval": {k: contract.get(k) for k in APPROVAL_KEYS},
        "capture": {"capture_id": inventory.get("capture_id"), "business_date": inventory.get("business_date"),
                    "sequence_manifest_checksum": inventory.get("sequence_manifest_checksum"),
                    "inventory_status": inventory.get("status"), "inventory_issues": len(inventory.get("issues") or [])},
        "lanes": _lanes(inventory),
        "datasets": {name: {k: spec.get(k) for k in ("level", "lag_sessions", "evidence", "limitations") if k in spec}
                     | {"features": len(spec.get("features") or ())}
                     for name, spec in (contract.get("datasets") or {}).items()},
        "revision_masks": masks,
        "evidence": evidence,
        "tests": tests,
        "limitations": [HISTORY_LIMITATION, *(contract.get("limitations") or [])],
        "generated_at": generated_at or datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    flag, reasons = derive(receipt, contract)
    receipt["reasons"] = reasons
    receipt["point_in_time_vintage_certified"] = flag
    return receipt


def attach(receipt: dict) -> dict:
    """The shape stored next to the capture and forwarded to training payloads."""
    return {"receipt": receipt, "receipt_sha256": canonical_sha256(receipt)}


def verify_receipt(attached, contract: dict | None = None) -> dict:
    """Fail-closed re-derivation. The recorded flag is never trusted on its own."""
    if not isinstance(attached, dict) or not isinstance(attached.get("receipt"), dict):
        return {"certified": False, "reasons": ["receipt_missing"]}
    receipt = attached["receipt"]
    if canonical_sha256(receipt) != attached.get("receipt_sha256"):
        return {"certified": False, "reasons": ["receipt_sha256_mismatch"]}
    try:
        flag, reasons = derive({k: v for k, v in receipt.items() if k not in ("reasons", "point_in_time_vintage_certified")},
                               contract if contract is not None else load_contract())
        capture_id = (receipt.get("capture") or {}).get("capture_id")
    except (AttributeError, TypeError):
        flag, reasons, capture_id = False, ["receipt_malformed"], None
    if receipt.get("point_in_time_vintage_certified") is not flag:
        reasons = [*reasons, "receipt_flag_not_derived"]
        flag = False
    return {"certified": flag, "reasons": reasons, "receipt_sha256": attached["receipt_sha256"],
            "contract_sha256": receipt.get("contract_sha256"), "capture_id": capture_id}


def capture_run_root(bucket, sequence_gcs_prefix: str) -> str:
    """Run root of the capture whose daily_price lane the sequence prep was built from."""
    from services.training_source_preflight import _sealed_manifest
    sequence = _sealed_manifest(bucket, sequence_gcs_prefix, "sequence_manifest.json", compact=True)
    daily = [r for r in sequence.get("lane_reports", []) if r.get("lane") == "daily_price"]
    uri = (daily[0].get("source_uri") or {}).get("close", "") if len(daily) == 1 else ""
    if not uri.startswith(f"gs://{bucket.name}/") or "/raw/daily_price_full_vintage/" not in uri:
        raise ValueError("pit_capture_root_unresolved")
    return uri.split("/", 3)[3].rsplit("/raw/daily_price_full_vintage/", 1)[0]


def load_capture_receipt(bucket, sequence_gcs_prefix: str):
    blob = bucket.blob(capture_run_root(bucket, sequence_gcs_prefix) + "/" + RECEIPT_FILE)
    if not blob.exists():
        return None
    value = json.loads(blob.download_as_text())
    return value if isinstance(value, dict) else None


def _blob_sha256(bucket, path) -> str | None:
    blob = bucket.blob(str(path or ""))
    return hashlib.sha256(blob.download_as_bytes()).hexdigest() if path and blob.exists() else None


def capture_binding_reasons(bucket, sequence_gcs_prefix: str, receipt: dict) -> list[str]:
    """The receipt describes this capture: same sequence manifest, lane manifests from this
    capture's own run root (not a copy of another capture's receipt), all unchanged."""
    from services.training_source_preflight import _sealed_manifest
    sequence = _sealed_manifest(bucket, sequence_gcs_prefix, "sequence_manifest.json", compact=True)
    root = capture_run_root(bucket, sequence_gcs_prefix)
    reasons = []
    if (receipt.get("capture") or {}).get("sequence_manifest_checksum") != sequence["manifest_checksum"]:
        reasons.append("receipt_capture_mismatch")
    for lane, entry in (receipt.get("lanes") or {}).items():
        manifests = entry.get("manifests") or {}
        if lane in LANE_MANIFESTS and set(manifests) != {root + "/raw" + LANE_MANIFESTS[lane]}:
            reasons.append("lane_manifest_foreign:" + lane)
        if any(_blob_sha256(bucket, path) != sha for path, sha in manifests.items()):
            reasons.append("lane_manifest_changed:" + lane)
        for field, binding in (entry.get("auxiliary_fields") or {}).items():
            binding = binding or {}
            path = str(binding.get("capture_manifest_path") or "")
            # Per-field auxiliary captures come from any sibling run under the parent prefix that
            # training_auxiliary_capture.select_field_captures searches, so this only rejects paths
            # outside it; prep_binding_reasons then requires the prep used these exact manifests.
            if (not path.startswith(root.rsplit("/", 1)[0] + "/")
                    or not path.endswith("/raw/training_auxiliary_full_vintage/manifest.json")):
                reasons.append(f"lane_field_foreign:{lane}:{field}")
            if _blob_sha256(bucket, path) != binding.get("capture_manifest_sha256"):
                reasons.append(f"lane_field_changed:{lane}:{field}")
    return reasons


def prep_binding_reasons(bucket, prep_gcs_prefix: str, receipt: dict) -> list[str]:
    """A certified flag needs prep built under the receipt's contract, capture and roster.

    prep_gcs_prefix is the canonical adjusted prep an OOF window or full-fit trains on; its
    sealed manifest names the source prep whose immutable receipt records the build inputs.
    """
    from services.training_source_preflight import _sealed_manifest
    tag = str(prep_gcs_prefix or "")
    try:
        adjusted = _sealed_manifest(bucket, tag, "manifest.json", compact=False)
        source = str(adjusted.get("source_gcs_prefix") or "").rstrip("/")
        blob = bucket.blob(f"{source}/prep/immutable_receipt.json")
        if not source or not blob.exists():
            return ["prep_receipt_missing:" + tag]
        prep = json.loads(blob.download_as_text())
    except (ValueError, KeyError, TypeError, AttributeError):
        return ["prep_receipt_unreadable:" + tag]
    unsigned = {k: v for k, v in prep.items() if k != "receipt_checksum"}
    checksum = hashlib.sha256(json.dumps(unsigned, sort_keys=True).encode("utf-8")).hexdigest()
    if prep.get("receipt_checksum") != checksum or adjusted.get("source_receipt_checksum") != checksum:
        return ["prep_receipt_checksum_mismatch:" + tag]
    reasons = []
    if (prep.get("pit_contract_version") != receipt.get("contract_version")
            or prep.get("pit_contract_sha256") != receipt.get("contract_sha256")):
        reasons.append("prep_not_built_under_contract:" + tag)
    if (prep.get("roster_sidecar") or {}).get("schema_version") != ROSTER_SIDECAR_SCHEMA:
        reasons.append("prep_roster_sidecar_missing:" + tag)
    if (prep.get("price_capture") or {}).get("capture_id") != (receipt.get("capture") or {}).get("capture_id"):
        reasons.append("prep_capture_mismatch:" + tag)
    fields = (prep.get("auxiliary_capture") or {}).get("field_captures") or {}
    for entry in (receipt.get("lanes") or {}).values():
        for field, binding in (entry.get("auxiliary_fields") or {}).items():
            if (fields.get(field) or {}).get("capture_manifest_sha256") != (binding or {}).get("capture_manifest_sha256"):
                reasons.append(f"prep_auxiliary_capture_mismatch:{tag}:{field}")
    applied = (prep.get("auxiliary_capture") or {}).get("fields") or {}
    for field, mask in (receipt.get("revision_masks") or {}).items():
        if ((applied.get(field) or {}).get("revision_mask") or {}).get("sha256") != (mask or {}).get("sha256"):
            reasons.append(f"prep_revision_mask_mismatch:{tag}:{field}")
    return reasons


def prep_batches_not_under_contract(results, binding: dict) -> list[int]:
    """Indexes of prep batches that did not report applying the contract the receipt names.

    The prep receipt records the controller's contract; ml-service applies the lags from its
    own image. Each batch's cleaning_report echoes what it loaded (an older ml-service ignores
    the request fields and reports nothing), so a mismatch never gets sealed.
    """
    if (binding or {}).get("pit_contract_version") is None:
        return []
    want = (binding["pit_contract_version"], binding.get("pit_contract_sha256"))
    bad = []
    for index, result in enumerate(results or ()):
        report = (result or {}).get("cleaning_report") if isinstance(result, dict) else None
        report = report if isinstance(report, dict) else {}
        if (report.get("pit_contract_version"), report.get("pit_contract_sha256")) != want:
            bad.append(index)
    return bad


def verify_bound_receipt(bucket, *, sequence_gcs_prefix: str, prep_gcs_prefixes=(), contract: dict | None = None) -> dict:
    """verify_receipt plus the bindings a stored receipt cannot prove by itself: it sits next to
    the capture it describes, and every prep the flag will cover was built under it."""
    attached = load_capture_receipt(bucket, sequence_gcs_prefix)
    verified = verify_receipt(attached, contract)
    if "receipt_sha256" not in verified:
        return {**verified, "attached": attached}
    receipt = attached["receipt"]
    try:
        extra = capture_binding_reasons(bucket, sequence_gcs_prefix, receipt)
        for prefix in dict.fromkeys(p for p in prep_gcs_prefixes if p):
            extra += prep_binding_reasons(bucket, prefix, receipt)
    except (AttributeError, TypeError):
        extra = ["receipt_binding_malformed"]
    return {**verified, "certified": verified["certified"] and not extra,
            "reasons": [*verified["reasons"], *extra], "binding_reasons": extra, "attached": attached}


def main(argv=None) -> int:
    """Local CLI: print a receipt for one capture. It reads GCS and writes nothing there."""
    import argparse
    from google.cloud import storage
    from services.capture_inventory import inspect_capture_inventory
    parser = argparse.ArgumentParser()
    parser.add_argument("--bucket", default="stockvision-models")
    parser.add_argument("--sequence-prefix", required=True)
    parser.add_argument("--run-date", required=True)
    parser.add_argument("--junit", action="append", required=True)
    parser.add_argument("--output", required=True, help="local path; uploading it is a separate go")
    args = parser.parse_args(argv)
    bucket = storage.Client().bucket(args.bucket)
    inventory = inspect_capture_inventory(bucket, sequence_gcs_prefix=args.sequence_prefix, run_date=args.run_date,
                                          per_field_auxiliary=True, require_aligned_history=True)
    receipt = certify(contract=load_contract(), inventory=inventory, tests=test_results_from_junit(args.junit))
    Path(args.output).write_text(json.dumps(attach(receipt), ensure_ascii=False, sort_keys=True, indent=1), encoding="utf-8")
    print(json.dumps({"point_in_time_vintage_certified": receipt["point_in_time_vintage_certified"],
                      "reasons": receipt["reasons"], "capture_run_root": capture_run_root(bucket, args.sequence_prefix)}))
    return 0 if receipt["point_in_time_vintage_certified"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
