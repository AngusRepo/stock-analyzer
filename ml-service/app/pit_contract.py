"""PIT availability contract (C28-02 C1/C2): feature-layer lags and receipt binding.

The contract JSON is the single owner of every lag. Model metadata reads the
certification flag only from a receipt derived by ml-controller
services/pit_certification.py; this module checks its binding, never sets it.
Keep canonical_sha256/content_sha256 identical to that module (test_pit_certification).
"""
from __future__ import annotations

import hashlib
import json
from functools import lru_cache
from pathlib import Path

CONTRACT_VERSION = "pit-availability-contract-v1"
RECEIPT_SCHEMA = "pit-vintage-certification-v1"
APPROVAL_KEYS = ("approved_by", "approved_at", "approved_content_sha256", "approval_status")
_FILES = {CONTRACT_VERSION: "pit_availability_contract_v1.json"}
# Artifacts and serving bind the version string only, so a version's lag table is frozen here:
# changing feature_lags needs a new contract version, never an edit under the same one.
_FEATURE_LAGS_SHA256 = {CONTRACT_VERSION: "e82bdf6ab2be524070e6bc3bd07b520feda52d9d392ceb64a99304d5ea823ae7"}
# Same text as ml-controller services/pit_certification.HISTORY_LIMITATION (test_pit_certification).
HISTORY_LIMITATION = ("Original publication timestamps for 2020-05..2026-05 are not proven: no archived "
                      "vintage exists for that period and neither FinLab nor TWSE provides them.")
_LEVELS = frozenset({"V", "O", "R", "I", "N/A"})


def canonical_sha256(value) -> str:
    raw = json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()


def content_sha256(contract: dict) -> str:
    return canonical_sha256({k: v for k, v in contract.items() if k not in APPROVAL_KEYS})


@lru_cache(maxsize=None)
def load(version: str) -> dict:
    if version not in _FILES:
        raise ValueError("pit_contract_version_unknown")
    here = Path(__file__).resolve()
    for root in (Path("/root/data/feature_registry"), Path("/app/data/feature_registry"),
                 here.parents[2] / "data" / "feature_registry"):
        path = root / _FILES[version]
        if path.exists():
            contract = json.loads(path.read_text(encoding="utf-8"))
            if contract.get("contract_version") != version:
                raise ValueError("pit_contract_version_mismatch")
            return contract
    raise ValueError("pit_contract_missing")


def feature_lags(version: str) -> dict[str, int]:
    lags = load(version).get("feature_lags")
    if not isinstance(lags, dict) or not all(isinstance(v, int) and not isinstance(v, bool) and v >= 0
                                             for v in lags.values()):
        raise ValueError("pit_contract_feature_lags_invalid")
    if canonical_sha256(lags) != _FEATURE_LAGS_SHA256.get(version):
        raise ValueError("pit_contract_feature_lags_changed_without_new_version")
    return {name: lag for name, lag in lags.items() if lag}


def vintage_scope(payload: dict) -> dict:
    """Flag fields for model metadata. True only from a bound, derived receipt.

    payload["pit_contract_version"] is the version the training prep was built under
    (the controller forwards it from the prep manifest). The artifact records it so
    serving builds features with the same lags, with or without a receipt.
    """
    attached, version = payload.get("pit_certification"), payload.get("pit_contract_version")
    if version is not None:
        load(version)
    if attached is None:
        return {"point_in_time_vintage_certified": False,
                **({"pit_contract_version": version} if version is not None else {})}
    receipt = attached.get("receipt") if isinstance(attached, dict) else None
    if (not isinstance(receipt, dict) or canonical_sha256(receipt) != attached.get("receipt_sha256")
            or receipt.get("schema_version") != RECEIPT_SCHEMA):
        raise ValueError("pit_certification_receipt_invalid")
    if receipt.get("contract_version") != version:
        raise ValueError("pit_certification_prep_version_mismatch")
    contract = load(receipt.get("contract_version"))
    if receipt.get("contract_sha256") != content_sha256(contract):
        raise ValueError("pit_certification_contract_mismatch")
    certified = receipt.get("point_in_time_vintage_certified") is True
    approved = (contract.get("approval_status") == "approved"
                and contract.get("approved_content_sha256") == receipt["contract_sha256"])
    if certified and (receipt.get("reasons") or not approved or _certified_gaps(receipt, contract)):
        raise ValueError("pit_certification_flag_not_derived")
    return {"point_in_time_vintage_certified": certified,
            "pit_certification_sha256": attached["receipt_sha256"],
            "pit_contract_sha256": receipt["contract_sha256"],
            # Serving must build features with this version (artifact_contract_version).
            "pit_contract_version": receipt["contract_version"]}


def _certified_gaps(receipt: dict, contract: dict) -> list[str]:
    """What a certified receipt must show against the contract it names. ml-controller
    derives the flag; this is a structural re-check, not a second derivation."""
    gaps = []
    results = (receipt.get("tests") or {}).get("results") or {}
    for key, pinned in (contract.get("required_tests") or {}).items():
        result = results.get(key) or {}
        if (result.get("status") != "passed" or result.get("file_sha256") != pinned.get("sha256")
                or result.get("tests") != pinned.get("cases")
                or any(result.get(k) != 0 for k in ("failures", "errors", "skipped"))):
            gaps.append("test:" + key)
    for group in ("evidence", "revision_masks"):
        recorded, declared = receipt.get(group) or {}, contract.get(group) or {}
        if set(recorded) != set(declared) or any(
                not (recorded[k] or {}).get("verified") or (recorded[k] or {}).get("sha256") != (declared[k] or {}).get("sha256")
                for k in declared):
            gaps.append(group)
    datasets = receipt.get("datasets") or {}
    if set(datasets) != set(contract.get("datasets") or {}) or any(
            (d or {}).get("level") not in _LEVELS for d in datasets.values()):
        gaps.append("datasets")
    if not isinstance(receipt.get("limitations"), list) or HISTORY_LIMITATION not in receipt["limitations"]:
        gaps.append("history_limitation")
    recorded = receipt.get("limitations")
    recorded = recorded if isinstance(recorded, list) else []
    if any(item not in recorded for item in contract.get("limitations") or []):
        gaps.append("contract_limitations")
    return gaps


def artifact_contract_version(meta) -> str | None:
    """The PIT contract version an artifact's training inputs were bound to, if any."""
    found, stack = set(), [meta]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            if "pit_contract_version" in node:
                found.add(node["pit_contract_version"])
            stack.extend(v for v in node.values() if isinstance(v, (dict, list)))
        elif isinstance(node, list):
            stack.extend(v for v in node if isinstance(v, (dict, list)))
    if len(found) > 1:
        raise ValueError("pit_contract_version_ambiguous")
    return next(iter(found), None)
