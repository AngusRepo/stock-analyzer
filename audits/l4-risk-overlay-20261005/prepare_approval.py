"""Prepare an exact Paper-only supplemental approval; never writes remote KV."""
from __future__ import annotations

import argparse
from copy import deepcopy
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))
from services import active8_paper_admission as paper  # noqa: E402
from services.paired_nav_journal import digest  # noqa: E402

MODEL_SHA = "9f179226aa7f5255d9221107386d377addcef29e5fdcd91e9d8be63fb6879a33"
NEW_OWNER = "native-paper-v1:b738eef531f291a276942ee0801cc44ae249fb40f4c88c4f67141f9ca1f40718"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--admission", type=Path, required=True)
    parser.add_argument("--prior-approval", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--receipt", type=Path, required=True)
    args = parser.parse_args()
    admission = json.loads(args.admission.read_text(encoding="utf-8"))
    prior = json.loads(args.prior_approval.read_text(encoding="utf-8"))
    if prior["admission"] != admission or prior["approved"] is not True:
        raise ValueError("prior_paper_approval_or_admission_changed")
    paper.validate_runtime_approval(prior, admission)
    old_config = prior["configuration"]
    expected_old = paper.L4_RISK_OVERLAY_SOURCE_CHANGE["allocator_sources"]["l4_distribution_runtime.py"]["previous"]
    approved = paper.L4_RISK_OVERLAY_SOURCE_CHANGE["allocator_sources"]["l4_distribution_runtime.py"]["approved"]
    if old_config["allocator_source_identity"]["l4_distribution_runtime.py"] != expected_old:
        raise ValueError("prior_l4_source_identity_mismatch")
    if old_config["trading_config"]["l4Distribution"]["artifact"]["model_checksum"] != MODEL_SHA:
        raise ValueError("seed42_model_identity_changed")
    if hashlib.sha256((ROOT / "ml-controller/services/l4_distribution_runtime.py").read_bytes()).hexdigest() != approved:
        raise ValueError("new_l4_source_identity_mismatch")
    new_admission_source = hashlib.sha256(
        (ROOT / "ml-controller/services/active8_paper_admission.py").read_bytes()).hexdigest()
    release = json.loads((ROOT / "ml-controller/services/native_execution_behavior_release.json").read_text())
    if release["execution_owner_version"] != NEW_OWNER:
        raise ValueError("native_execution_owner_release_mismatch")
    for flag in ("LIVE_EXECUTION_CLIENT_ENABLED", "LIVE_EXECUTION_SUBMIT_GUARD_ENABLED"):
        if str(old_config["native_execution_policy"]["variables"].get(flag, "")).lower() in (
                "1", "true", "yes", "enabled", "on"):
            raise ValueError("live_order_flag_enabled")

    proposal = deepcopy(prior)
    proposal["approved_at"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    proposal["source_reference"] = (
        "Wei 2026-10-05 Codex approval: publish risk_overlay.skip L4 Paper new-buy gate only; "
        "retain seed42 model, account, risk limits and live-order-disabled settings")
    proposal["approved_l4_risk_overlay_source_change"] = deepcopy(paper.L4_RISK_OVERLAY_SOURCE_CHANGE)
    config = proposal["configuration"]
    config["allocator_source_identity"]["l4_distribution_runtime.py"] = approved
    config["l3_inference_source_identity"]["active8_paper_admission.py"] = new_admission_source
    config["native_execution_policy"]["execution_owner_version"] = NEW_OWNER
    proposal["approval_checksum"] = digest({k: v for k, v in proposal.items() if k != "approval_checksum"})
    paper.validate_runtime_approval(proposal, admission)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(proposal, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    receipt = {
        "status": "local_validation_passed_remote_unstaged",
        "approval_key": paper.L4_RISK_OVERLAY_RUNTIME_RELEASE_KEY,
        "approval_checksum": proposal["approval_checksum"],
        "model_checksum_unchanged": MODEL_SHA,
        "l4_source_previous": expected_old,
        "l4_source_approved": approved,
        "admission_source_approved": new_admission_source,
        "native_execution_owner_approved": NEW_OWNER,
        "maturity_transfer": False,
        "live_order_flags_disabled": True,
        "prior_key_preserved": paper.ENTRY_UI_RUNTIME_RELEASE_KEY,
    }
    args.receipt.parent.mkdir(parents=True, exist_ok=True)
    args.receipt.write_bytes(json.dumps(receipt, indent=2).encode("utf-8"))
    print(json.dumps(receipt))


if __name__ == "__main__":
    main()
