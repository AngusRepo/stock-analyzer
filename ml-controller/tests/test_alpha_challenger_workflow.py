from __future__ import annotations

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from routers import config_pool  # noqa: E402
from test_promotion_service import _exact_dsr_inputs, _promotion_grade_data_snooping

CID = 'parameter:alpha_framework:alpha_framework:2026-04-26T00:00:00Z:abcd1234'


def _sandbox_record() -> dict:
    return {
        "success": True,
        "id": "trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
        "source": "alpha_framework",
        "config": {"alphaFramework": {"allocation": {"weights": {}}}},
        "metadata": {
            "status": "completed",
            "target": "sandbox",
            "sample_count": 96,
            "regime_counts": {"bull": 24, "bear": 24, "volatile": 24, "sideways": 24},
        },
    }


def _evidence(candidate_id: str) -> dict:
    return {
        "candidate_id": candidate_id,
        "backtest": {
            "mode": "B",
            "total_trades": 120,
            "sharpe": 1.2,
            "profit_factor": 1.5,
            "max_drawdown": 0.1,
            "absolute_confidence": "moderate",
            "sanity_flags": [],
            "parity_audit": {"worker_parity": {"decision": "PASS"}},
        },
        "monte_carlo": {
            "source": "backtest",
            "n_trades": 120,
            "simulation_method": "block_bootstrap",
            "mdd_95th": 0.16,
            "go_live_verdict": "PASS",
        },
        "pbo": {
            "source": "backtest",
            "n_trades": 120,
            "method": "cscv_rank_logit",
            "pbo": 0.31,
            "oos_mean_return": 0.03,
            "go_live_verdict": "PASS",
        },
    }


def _passing_evidence(candidate_id: str) -> dict:
    bundle = _evidence(candidate_id)
    bundle['backtest'].update(_exact_dsr_inputs())
    bundle['backtest']['per_regime'] = {'bull': {'trades': 60, 'return': .03},
                                       'bear': {'trades': 60, 'return': .01}}
    bundle['walk_forward'] = {'passed': True, 'windows': 6}
    bundle['data_snooping'] = _promotion_grade_data_snooping()
    bundle["gate"] = {"decision": "PASS", "passed": True, "failed_gates": []}
    return bundle


@pytest.mark.asyncio
async def test_alpha_challenger_dry_run_does_not_set_challenger(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        raise AssertionError(f"unexpected worker call: {method} {path}")

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            apply=False,
            evidence=_passing_evidence(CID),
        )
    )

    assert out["status"] == "dry_run"
    assert out["gate"]["decision"] == "PASS"
    assert all(call[0] != "/api/admin/config/challenger" for call in calls)


@pytest.mark.asyncio
async def test_alpha_challenger_apply_requires_passed_gate(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        raise AssertionError(f"unexpected worker call: {method} {path}")

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            apply=True,
            confirm=True,
        )
    )

    assert out["status"] == "gate_failed"
    assert "alpha_evidence_candidate_missing" in out["gate"]["failed_gates"]
    assert all(call[0] != "/api/admin/config/challenger" for call in calls)


@pytest.mark.asyncio
async def test_alpha_challenger_apply_sets_challenger_only_with_confirmed_pass(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        if path == "/api/admin/config/challenger":
            return {"success": True, "challenger": {"hash": "abc"}}
        raise AssertionError(f"unexpected worker call: {method} {path}")

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            apply=True,
            confirm=True,
            evidence=_passing_evidence(CID),
        )
    )

    challenger_calls = [call for call in calls if call[0] == "/api/admin/config/challenger"]
    assert out["status"] == "applied"
    assert challenger_calls
    assert challenger_calls[0][2]["sandbox_id"].startswith("trading:config:sandbox:alpha_framework:")
    assert challenger_calls[0][2]["gate"]["decision"] == "PASS"


@pytest.mark.asyncio
@pytest.mark.parametrize('fault,reason', [('wrong_candidate', 'alpha_evidence_candidate_mismatch'),
    ('bad_metrics', 'backtest_sharpe'), ('producer_failure', 'alpha_replay_not_applied')])
async def test_generated_embedded_pass_cannot_bypass_identity_metrics_or_producer_failure(monkeypatch, fault, reason):
    async def worker(path, method='GET', json_body=None, headers=None):
        if path.startswith('/api/admin/config/sandbox/'):
            return _sandbox_record()
        if path == '/api/admin/config':
            return {'alphaFramework': {}}
        raise AssertionError('invalid evidence must never reach challenger writer')

    def generated(candidate, **kwargs):
        evidence = _passing_evidence(candidate['id'])
        if fault == 'wrong_candidate':
            evidence['candidate_id'] = 'different-candidate'
        elif fault == 'bad_metrics':
            evidence['backtest']['sharpe'] = -1
        else:
            evidence['gate'] = {'decision': 'FAIL', 'failed_gates': ['alpha_replay_not_applied']}
        return evidence

    monkeypatch.setattr(config_pool, 'worker_fetch', worker)
    monkeypatch.setattr(config_pool, 'run_alpha_candidate_evidence', generated)
    result = await config_pool.alpha_challenger_gate(config_pool.AlphaChallengerRequest(
        sandbox_id=_sandbox_record()['id'], generate_evidence=True, start_date='2026-01-01',
        end_date='2026-03-31', apply=True, confirm=True))
    assert result['status'] == 'gate_failed'
    assert reason in result['gate']['failed_gates']


@pytest.mark.asyncio
async def test_alpha_challenger_rejects_mismatched_candidate_evidence(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        raise AssertionError(f"unexpected worker call: {method} {path}")

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            apply=True,
            confirm=True,
            evidence=_evidence("wrong-candidate"),
        )
    )

    assert out["status"] == "gate_failed"
    assert "alpha_evidence_candidate_mismatch" in out["gate"]["failed_gates"]
    assert all(call[0] != "/api/admin/config/challenger" for call in calls)


@pytest.mark.asyncio
async def test_alpha_challenger_can_generate_candidate_specific_evidence_dry_run(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []
    runner_calls: list[tuple[dict, dict]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        if path == "/api/admin/config":
            return {"alphaFramework": {"allocation": {"slateSize": 10}}, "position": {"maxPositions": 5}}
        raise AssertionError(f"unexpected worker call: {method} {path}")

    def fake_runner(candidate: dict, **kwargs):
        runner_calls.append((candidate, kwargs))
        return _passing_evidence(candidate["id"])

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)
    monkeypatch.setattr(config_pool, "run_alpha_candidate_evidence", fake_runner)

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            generate_evidence=True,
            start_date="2026-01-01",
            end_date="2026-03-31",
            apply=False,
        )
    )

    assert out["status"] == "dry_run"
    assert out["gate"]["decision"] == "PASS"
    assert out["evidence"]["candidate_id"] == (
        "parameter:alpha_framework:alpha_framework:2026-04-26T00:00:00Z:abcd1234"
    )
    assert runner_calls[0][1]["baseline_config"]["position"]["maxPositions"] == 5
    assert runner_calls[0][1]["start_date"] == "2026-01-01"
    assert all(call[0] != "/api/admin/config/challenger" for call in calls)


@pytest.mark.asyncio
async def test_alpha_challenger_auto_evidence_apply_sets_challenger_after_pass(monkeypatch):
    calls: list[tuple[str, str, dict | None]] = []

    async def fake_worker_fetch(path: str, method: str = "GET", json_body=None, headers=None):
        calls.append((path, method, json_body))
        if path.startswith("/api/admin/config/sandbox/"):
            return _sandbox_record()
        if path == "/api/admin/config":
            return {"alphaFramework": {"allocation": {"slateSize": 10}}}
        if path == "/api/admin/config/challenger":
            return {"success": True, "challenger": {"hash": "abc"}}
        raise AssertionError(f"unexpected worker call: {method} {path}")

    monkeypatch.setattr(config_pool, "worker_fetch", fake_worker_fetch)
    monkeypatch.setattr(
        config_pool,
        "run_alpha_candidate_evidence",
        lambda candidate, **kwargs: _passing_evidence(candidate["id"]),
    )

    out = await config_pool.alpha_challenger_gate(
        config_pool.AlphaChallengerRequest(
            sandbox_id="trading:config:sandbox:alpha_framework:2026-04-26T00:00:00Z:abcd1234",
            generate_evidence=True,
            start_date="2026-01-01",
            end_date="2026-03-31",
            apply=True,
            confirm=True,
        )
    )

    challenger_calls = [call for call in calls if call[0] == "/api/admin/config/challenger"]
    assert out["status"] == "applied"
    assert challenger_calls
    assert challenger_calls[0][2]["gate"]["decision"] == "PASS"
