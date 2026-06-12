from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.local_prod_ready_audit import build_local_prod_ready_audit


def _write(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")


def test_local_prod_ready_audit_marks_done_when_local_gates_are_closed(tmp_path):
    _write(
        tmp_path / "infra/gcp-scheduler-jobs.json",
        json.dumps({
            "jobs": [
                {"id": "weekly-optuna"},
                {"id": "adaptive-meta-policy-replay"},
                {"id": "linucb-multiplier-replay"},
                {"id": "monthly-optuna"},
                {"id": "optuna-queue"},
            ]
        }),
    )
    _write(
        tmp_path / "ml-service/requirements.txt",
        "\n".join([
            "scikit-learn==1.9.0",
            "xgboost==3.2.0",
            "lightgbm==4.6.0",
            "torch==2.12.0",
            "torch-geometric==2.8.0",
            "neuralforecast==3.1.9",
            "tabm==0.0.3",
            "timesfm[torch]==2.0.1",
        ]),
    )
    _write(
        tmp_path / "frontend/src/pages/ModelPoolPage.tsx",
        "ModelPoolNewFlowWorkbench !isRetiredModelName(name)",
    )
    _write(
        tmp_path / "frontend/src/components/model-pool/ModelPoolNewFlowWorkbench.tsx",
        "adaptive-meta-policy-replay linucb-multiplier-replay",
    )
    for name in (
        "adaptive_meta_policy_replay_20260605_20260611.json",
        "linucb_multiplier_replay_20260605_20260611.json",
    ):
        _write(
            tmp_path / f"ml-service/benchmark_results/{name}",
            json.dumps({"status": "fail", "allowed_use": "research_only", "production_effect": False}),
        )

    audit = build_local_prod_ready_audit(tmp_path)

    assert audit["local_closure"] == "done"
    assert audit["local_prod_ready"] == "done"
    assert audit["promotion_allowed"] is False
    assert audit["production_mutation_allowed"] is False
    assert audit["failed_checks"] == []
    assert "sync_gcp_scheduler_manifest" in audit["production_cutover_requires_wei_approval"]
