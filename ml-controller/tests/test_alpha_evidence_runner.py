from __future__ import annotations

import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.alpha_evidence_runner import run_alpha_candidate_evidence  # noqa: E402
from routers import backtest  # noqa: E402


@dataclass
class FakeTrade:
    profit_ratio: float
    entry_regime: str = "green"
    symbol: str = "2330"
    entry_date: str = "2026-01-01"
    exit_date: str = "2026-01-02"
    entry_price: float = 100.0
    exit_price: float = 101.0
    shares: int = 1000
    exit_reason: str = "test"
    days_held: int = 1


@dataclass
class FakeMetrics:
    mode: str = "B"
    start_date: str = "2026-01-01"
    end_date: str = "2026-03-31"
    initial_capital: float = 1_000_000
    final_equity: float = 1_120_000
    total_return: float = 0.12
    cagr: float = 0.24
    sharpe: float = 1.2
    sortino: float = 1.5
    calmar: float = 2.0
    max_drawdown: float = 0.10
    max_drawdown_date: str = "2026-02-01"
    total_trades: int = 72
    wins: int = 48
    losses: int = 24
    win_rate: float = 0.6667
    gross_profit: float = 1.2
    gross_loss: float = 0.4
    profit_factor: float = 1.5
    expectancy: float = 0.02
    absolute_confidence: str = "moderate"
    sanity_flags: list[str] = field(default_factory=list)
    trades: list[FakeTrade] = field(default_factory=list)
    partition_returns: list[float] = field(default_factory=list)


def _metrics(returns: list[float], partitions: list[float]) -> FakeMetrics:
    return FakeMetrics(
        total_trades=len(returns),
        trades=[FakeTrade(value, "green" if idx % 2 == 0 else "red") for idx, value in enumerate(returns)],
        partition_returns=partitions,
    )


def test_run_alpha_candidate_evidence_replays_champion_and_candidate_for_cscv_pbo():
    calls: list[dict] = []
    champion = _metrics([0.01] * 72, [0.01, 0.01, 0.01, 0.01, 0.01, 0.01])
    candidate_metrics = _metrics([0.02] * 72, [0.03, 0.025, 0.028, 0.026, 0.031, 0.027])

    def fake_dataset_loader(**kwargs):
        assert kwargs["start_date"] == "2026-01-01"
        return {"dataset": True}

    def fake_replay(**kwargs):
        calls.append(kwargs)
        return champion if len(calls) == 1 else candidate_metrics

    candidate = {
        "id": "alpha-1",
        "source": "alpha_framework",
        "config": {"alphaFramework": {"allocation": {"slateSize": 8}}},
        "metadata": {
            "status": "completed",
            "target": "sandbox",
            "sample_count": 96,
            "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        },
    }

    out = run_alpha_candidate_evidence(
        candidate,
        start_date="2026-01-01",
        end_date="2026-03-31",
        baseline_config={"alphaFramework": {"allocation": {"slateSize": 10}}, "position": {"maxPositions": 5}},
        dataset_loader=fake_dataset_loader,
        replay_fn=fake_replay,
        mc_simulations=20,
        parity_audit={"worker_parity": {"decision": "PASS"}},
        alpha_replay_applied=True,
    )

    assert out["candidate_id"] == "alpha-1"
    assert out["backtest"]["mode"] == "B"
    assert out["backtest"]["total_trades"] == 72
    assert out["monte_carlo"]["source"] == "backtest"
    assert out["monte_carlo"]["simulation_method"] == "regime_block_bootstrap"
    assert out["pbo"]["method"] == "cscv_rank_logit"
    assert out["pbo"]["n_trades"] == 72
    assert out["gate"]["decision"] == "PASS"
    assert calls[0]["params"]["alphaFramework"]["allocation"]["slateSize"] == 10
    assert calls[1]["params"]["alphaFramework"]["allocation"]["slateSize"] == 8
    assert calls[1]["mode"] == "B"


def test_alpha_candidate_evidence_fails_closed_without_alpha_aware_replay():
    returns = [0.02] * 72
    partitions = [0.03, 0.025, 0.028, 0.026, 0.031, 0.027]
    metrics = _metrics(returns, partitions)

    out = run_alpha_candidate_evidence(
        {
            "id": "alpha-1",
            "source": "alpha_framework",
            "config": {"alphaFramework": {"allocation": {"slateSize": 8}}},
            "metadata": {
                "status": "completed",
                "target": "sandbox",
                "sample_count": 96,
                "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
            },
        },
        start_date="2026-01-01",
        end_date="2026-03-31",
        baseline_config={"alphaFramework": {"allocation": {"slateSize": 10}}},
        dataset_loader=lambda **kwargs: {},
        replay_fn=lambda **kwargs: metrics,
        mc_simulations=20,
        parity_audit={"worker_parity": {"decision": "PASS"}},
    )

    assert out["gate"]["decision"] == "FAIL"
    assert "alpha_replay_not_applied" in out["gate"]["failed_gates"]
    assert out["provenance"]["alpha_replay_applied"] is False


def test_alpha_evidence_endpoint_is_read_only_gate_packet(monkeypatch):
    captured = {}

    def fake_runner(candidate, **kwargs):
        captured["candidate"] = candidate
        captured["kwargs"] = kwargs
        return {
            "candidate_id": "alpha-1",
            "backtest": {"mode": "B"},
            "monte_carlo": {"go_live_verdict": "PASS"},
            "pbo": {"go_live_verdict": "PASS"},
            "gate": {"decision": "PASS"},
        }

    monkeypatch.setattr(backtest, "run_alpha_candidate_evidence", fake_runner)

    out = backtest.post_alpha_evidence(
        backtest.AlphaEvidenceRequest(
            candidate={"id": "alpha-1", "config": {"alphaFramework": {}}},
            start_date="2026-01-01",
            end_date="2026-03-31",
            baseline_config={"position": {"maxPositions": 5}},
            parity_audit={"worker_parity": {"decision": "PASS"}},
            mc_simulations=100,
        )
    )

    assert out["status"] == "ok"
    assert out["candidate_id"] == "alpha-1"
    assert captured["kwargs"]["baseline_config"]["position"]["maxPositions"] == 5
    assert captured["kwargs"]["parity_audit"]["worker_parity"]["decision"] == "PASS"
