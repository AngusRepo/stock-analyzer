from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


ARTIFACT_LIFECYCLE_REPAIR_PACKET_SCHEMA_VERSION = "artifact-lifecycle-repair-packet-v1"


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _as_float(value: Any) -> float | None:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return None
    return parsed


def _approval_action(
    *,
    model_name: str,
    version: str | None,
    root_cause: str,
    recommendation: str,
    evidence: dict[str, Any],
    requires_live_readback: bool = False,
) -> dict[str, Any]:
    return {
        "model_name": model_name,
        "version": version,
        "root_cause": root_cause,
        "recommendation": recommendation,
        "decision_effect": "local_plan_only",
        "production_mutation_allowed": False,
        "requires_wei_approval": True,
        "requires_live_readback": requires_live_readback,
        "evidence": evidence,
    }


def build_artifact_lifecycle_repair_packet(
    release_evidence: dict[str, Any],
    *,
    generated_at: str | None = None,
) -> dict[str, Any]:
    """Build a non-mutating repair plan for artifact lifecycle release drift."""
    run = release_evidence.get("run") if isinstance(release_evidence.get("run"), dict) else {}
    training = release_evidence.get("training") if isinstance(release_evidence.get("training"), dict) else {}
    lifecycle = release_evidence.get("artifact_lifecycle") if isinstance(release_evidence.get("artifact_lifecycle"), dict) else {}
    model_pool_release = release_evidence.get("model_pool_release") if isinstance(release_evidence.get("model_pool_release"), dict) else {}
    artifacts = lifecycle.get("artifacts") if isinstance(lifecycle.get("artifacts"), dict) else {}
    kept_versions = (
        model_pool_release.get("models_kept_at_previous_version")
        if isinstance(model_pool_release.get("models_kept_at_previous_version"), dict)
        else {}
    )
    ic_summary = training.get("ic_summary") if isinstance(training.get("ic_summary"), dict) else {}

    actions: list[dict[str, Any]] = []
    no_action: list[dict[str, Any]] = []
    for model_name, artifact in sorted(artifacts.items()):
        if not isinstance(artifact, dict):
            continue
        version = str(artifact.get("version") or "") or None
        offline_decision = str(artifact.get("offline_gate_decision") or "").upper()
        cpcv_decision = str(artifact.get("model_cpcv_decision") or "").upper()
        pointer_updated = artifact.get("production_pointer_updated") is True
        oos_ic = _as_float(artifact.get("oos_ic"))
        evidence = {
            "offline_gate_decision": offline_decision or None,
            "model_cpcv_decision": cpcv_decision or None,
            "production_pointer_updated": pointer_updated,
            "oos_ic": oos_ic,
            "artifact_path": artifact.get("path"),
        }

        if pointer_updated and offline_decision == "FAIL":
            if oos_ic is not None and oos_ic < 0:
                actions.append(_approval_action(
                    model_name=model_name,
                    version=version,
                    root_cause="production_pointer_updated_despite_true_performance_fail",
                    recommendation="Rollback or remove this serving candidate after current model_pool/champion pointer readback.",
                    evidence=evidence,
                    requires_live_readback=True,
                ))
            else:
                actions.append(_approval_action(
                    model_name=model_name,
                    version=version,
                    root_cause="production_pointer_updated_despite_cpcv_coverage_contract_drift",
                    recommendation="Recompute offline gate with coverage_gate_value semantics before deciding keep versus rollback.",
                    evidence=evidence,
                    requires_live_readback=True,
                ))
        elif pointer_updated and offline_decision in {"PASS", "STRONG_PASS"}:
            no_action.append({
                "model_name": model_name,
                "version": version,
                "reason": "production pointer update is aligned with offline gate",
            })
        elif offline_decision == "FAIL" or cpcv_decision == "FAIL":
            no_action.append({
                "model_name": model_name,
                "version": version,
                "reason": "artifact did not update production pointer; keep as evidence until revalidated",
            })

    for model_name, previous_version in sorted(kept_versions.items()):
        if model_name not in ic_summary:
            continue
        if model_name == "StackingRank":
            continue
        actions.append(_approval_action(
            model_name=model_name,
            version=str(run.get("candidate_version") or ""),
            root_cause="offline_pass_candidate_not_released_to_model_pool",
            recommendation="Run promotion-controller dry-run, then require Wei approval before model_pool release writer confirm.",
            evidence={
                "candidate_version": run.get("candidate_version"),
                "current_model_pool_version": previous_version,
                "oos_ic": ic_summary.get(model_name),
            },
        ))

    return {
        "schema_version": ARTIFACT_LIFECYCLE_REPAIR_PACKET_SCHEMA_VERSION,
        "generated_at": generated_at or _now_iso(),
        "decision_effect": "local_repair_plan_only",
        "production_mutation_allowed": False,
        "source_evidence_schema_version": release_evidence.get("schema_version"),
        "run": {
            "run_id": run.get("run_id"),
            "candidate_version": run.get("candidate_version"),
            "status": run.get("status"),
            "is_monthly": run.get("is_monthly"),
        },
        "summary": {
            "action_count": len(actions),
            "requires_wei_approval_count": sum(1 for action in actions if action.get("requires_wei_approval") is True),
            "production_pointer_fail_closed_repairs": [
                action["model_name"]
                for action in actions
                if str(action.get("root_cause") or "").startswith("production_pointer_updated_despite")
            ],
            "offline_pass_pending_release": [
                action["model_name"]
                for action in actions
                if action.get("root_cause") == "offline_pass_candidate_not_released_to_model_pool"
            ],
            "no_action_count": len(no_action),
        },
        "actions": actions,
        "no_action": no_action,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Build local artifact lifecycle repair packet.")
    parser.add_argument("--input", required=True, help="Path to production retrain/release evidence JSON.")
    parser.add_argument("--output", required=True, help="Output repair packet JSON path.")
    args = parser.parse_args(argv)

    input_path = Path(args.input)
    output_path = Path(args.output)
    evidence = json.loads(input_path.read_text(encoding="utf-8"))
    packet = build_artifact_lifecycle_repair_packet(evidence)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(packet, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "action_count": packet["summary"]["action_count"],
        "production_mutation_allowed": packet["production_mutation_allowed"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
