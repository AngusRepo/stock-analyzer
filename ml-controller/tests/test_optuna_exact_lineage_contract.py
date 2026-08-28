from __future__ import annotations

import hashlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from services.alpha_evidence_runner import _backtest_row  # noqa: E402
from services.validation_governance import deflated_sharpe_evidence  # noqa: E402


def _checksum(values: list[float]) -> str:
    payload = json.dumps([round(float(value), 12) for value in values], separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def test_optimizer_trial_distribution_reaches_exact_dsr_gate() -> None:
    distribution = [0.2, 0.4, 0.1, 0.35]
    lineage = {
        "artifact_id": "optuna-l2-trials-test",
        "payload_checksum": _checksum(distribution),
        "as_of_date": "2026-08-27",
        "pit_fenced": True,
    }
    row = _backtest_row(
        {
            "end_date": "2026-08-27",
            "total_trades": 6,
            "sharpe": 0.3,
            "profit_factor": 1.1,
            "max_drawdown": 0.1,
            "trades": [
                {"profit_ratio": value, "entry_regime": "bull"}
                for value in [0.01, -0.005, 0.02, 0.003, 0.015, -0.002]
            ],
        },
        parity_audit={"worker_parity": {"decision": "PASS"}},
        optimizer_evidence={
            "trial_sharpe_distribution": distribution,
            "effective_trials": len(distribution),
            "trial_distribution_lineage": lineage,
        },
    )
    assert row["return_series"] == [0.01, -0.005, 0.02, 0.003, 0.015, -0.002]
    evidence = deflated_sharpe_evidence(row)
    assert evidence["exact_formula"] is True
    assert evidence["trial_distribution_lineage_valid"] is True
    assert evidence["method"] == "deflated_sharpe_bailey_lopez_de_prado_v2"


def test_l2_producer_is_snapshot_fenced_and_emits_trial_lineage() -> None:
    source = (ROOT / "optuna_scripts" / "optuna_l2_sensitivity.py").read_text(encoding="utf-8")
    assert "BacktestDataset.load_from_d1(" not in source
    assert 'mode="snapshot"' in source
    assert 'trial.set_user_attr("sharpe", sharpe)' in source
    assert '"optimizer_evidence": optimizer_evidence' in source
    assert 'sampler_name: str = "tpe"' in source


def test_worker_registry_preserves_optimizer_lineage() -> None:
    source = (ROOT.parent / "worker" / "src" / "routes" / "adminOptunaRoutes.ts").read_text(encoding="utf-8")
    assert "optimizer_evidence: meta?.optimizer_evidence ?? null" in source
    assert "data_access: meta?.data_access ?? null" in source
