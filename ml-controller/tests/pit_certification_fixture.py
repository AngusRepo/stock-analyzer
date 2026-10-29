"""Receipts for PIT gate tests: an approved copy of the repo contract and a receipt
that certify() derives from it. No test hand-sets point_in_time_vintage_certified."""
import copy

from services import pit_certification as pc
from services.training_auxiliary_capture import FIELDS

SHA = "a" * 64


def approve(contract):
    contract = copy.deepcopy(contract)
    contract.update(approved_by="test", approved_at="2026-10-28T12:00:00+08:00", approval_status="approved")
    contract["approved_content_sha256"] = pc.contract_content_sha256(contract)
    return contract


def pending(contract):
    """The contract as it stands before Wei's approval, whatever the repo copy says."""
    contract = copy.deepcopy(contract)
    contract.update(approved_by=None, approved_at=None, approved_content_sha256=None, approval_status="pending_wei")
    return contract


def approved_contract():
    return approve(pc.load_contract())


def inventory(**changes):
    manifests = {"finlab/v4/backfill/run/raw" + suffix: SHA for suffix in pc.LANE_MANIFESTS.values()}
    auxiliary = {f: {"capture_id": "run", "capture_manifest_path": "p/manifest.json", "capture_manifest_sha256": SHA}
                 for f in FIELDS}
    return {"status": "inventory_ready", "capture_id": "run", "business_date": "2026-10-30",
            "sequence_manifest_checksum": "s" * 64, "manifest_sha256": manifests, "issues": [],
            "auxiliary_field_captures": auxiliary, **changes}


def passed_tests(**status):
    """Results matching the files and case counts the repo contract pins."""
    pinned = pc.load_contract()["required_tests"]
    return {"junit_sha256": {}, "results": {
        key: {"tests": pinned[key]["cases"], "failures": 0, "errors": 0, "skipped": 0, "file": rel,
              "file_sha256": pinned[key]["sha256"], "status": status.get(key, "passed")}
        for key, rel in pc.REQUIRED_TESTS.items()}}


def certified(contract=None, **kwargs):
    contract = contract or approved_contract()
    receipt = pc.certify(contract=contract, inventory=kwargs.get("inventory") or inventory(),
                         tests=kwargs.get("tests") or passed_tests(), generated_at="2026-10-30T13:00:00+00:00")
    return pc.attach(receipt), contract
