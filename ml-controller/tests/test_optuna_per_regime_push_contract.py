from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "optuna_scripts"))

import optuna_per_regime_robust as per_regime  # noqa: E402


def test_push_winner_preserves_worker_target_and_sandbox_id(monkeypatch):
    captured: dict = {}

    def fake_push(*, source, params, meta):
        captured.update({"source": source, "params": params, "meta": meta})
        return {
            "success": True,
            "target": "sandbox",
            "sandbox_id": "trading:config:sandbox:sltp:run:abcd1234",
        }

    monkeypatch.setattr(per_regime, "push_optuna_result", fake_push)
    result = {
        "robust_sharpe": 1.23,
        "sharpe_per_regime": {"bull_market": 1.5, "bear_market": 0.4},
    }

    response = per_regime._push_winner("sltp", {"sl_mult": 1.2}, result)

    assert response == result["push"]
    assert result["kv_push_ok"] is True
    assert result["push"]["target"] == "sandbox"
    assert result["push"]["sandbox_id"].endswith("abcd1234")
    assert captured == {
        "source": "sltp",
        "params": {"sl_mult": 1.2},
        "meta": {
            "optuna_source": "per_regime_robust",
            "robust_sharpe": 1.23,
            "sharpe_per_regime": {"bull_market": 1.5, "bear_market": 0.4},
        },
    }


def test_push_winner_ignores_unsupported_target(monkeypatch):
    monkeypatch.setattr(
        per_regime,
        "push_optuna_result",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("push must not run")),
    )
    result = {"robust_sharpe": 0.5, "sharpe_per_regime": {}}

    assert per_regime._push_winner("unsupported", {}, result) is None
    assert "push" not in result
    assert "kv_push_ok" not in result