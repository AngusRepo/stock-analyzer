import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import pytest


import strategy_mining_job_main as job
from strategy_mining_job_main import _callback_worker_scheduler, _deduped_finlab_confirm
from services import d1_client


class _CallbackResponse:
    status_code = 200
    text = '{"ok":true}'


def test_finlab_confirm_dedupes_exact_factor_sets_before_backtest_persist():
    report = {
        "rows": [
            {
                "candidate_id": "pymoo_nsga3_novelty_0260",
                "factor_ids": ["l1_brokerNetAmount5d", "tech_sar", "mom_9m"],
            },
            {
                "candidate_id": "pymoo_nsga3_novelty_0108",
                "factor_ids": ["mom_9m", "tech_sar", "l1_brokerNetAmount5d"],
            },
            {
                "candidate_id": "pymoo_nsga3_novelty_0019",
                "factor_ids": ["l1_sectorFlowCore", "vwap_bias"],
            },
        ],
        "finlab_confirm": [
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0260",
                "monthly_sharpe": 1.28,
                "cagr": 0.46,
                "calmar": 1.47,
            },
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0108",
                "monthly_sharpe": 1.26,
                "cagr": 0.46,
                "calmar": 1.47,
            },
            {
                "id": "alpha_miner_pymoo_nsga3_novelty_0019",
                "monthly_sharpe": 1.29,
                "cagr": 0.53,
                "calmar": 2.19,
            },
        ],
    }

    deduped = _deduped_finlab_confirm(report)
    ids = {row["id"] for row in deduped}

    assert ids == {
        "alpha_miner_pymoo_nsga3_novelty_0260",
        "alpha_miner_pymoo_nsga3_novelty_0019",
    }


def test_strategy_mining_terminal_callback_uses_scheduler_contract(monkeypatch):
    observed = {}
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example.test")
    monkeypatch.setenv("STRATEGY_MINING_CALLBACK_TOKEN", "test-token")

    def fake_post(url, *, headers, content, timeout):
        observed["url"] = url
        observed["authorization"] = headers["Authorization"]
        observed["user_agent"] = headers["User-Agent"]
        observed["body"] = content.decode("utf-8")
        observed["timeout"] = timeout
        return _CallbackResponse()

    monkeypatch.setattr(job.httpx, "post", fake_post)
    result = _callback_worker_scheduler({
        "task": "monthly-strategy-mining",
        "status": "success",
        "run_id": "strategy-mining-2026-08-01-test",
    })

    assert result == {"attempted": True, "ok": True, "attempt": 1, "status_code": 200}
    assert observed["url"].endswith("/api/internal/strategy-mining/callback")
    assert observed["authorization"] == "Bearer test-token"
    assert '"task":"monthly-strategy-mining"' in observed["body"]
    assert observed["timeout"] == 15.0
    assert observed["user_agent"] == "StockVision-Strategy-Mining/1.0"


def test_strategy_mining_d1_gateway_uses_dedicated_token(monkeypatch):
    observed = {}

    class Response:
        status_code = 200
        text = '{"ok":true}'

        @staticmethod
        def json():
            return {
                "ok": True,
                "results": [{"success": True, "results": [{"run_id": "run-1"}], "meta": {}}],
            }

    def fake_post(url, *, headers, json, timeout):
        observed.update(url=url, headers=headers, json=json, timeout=timeout)
        return Response()

    monkeypatch.setattr(d1_client, "STRATEGY_MINING_D1_WORKER_ONLY", True)
    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example.test")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "dedicated-token")
    monkeypatch.setattr(d1_client.httpx, "post", fake_post)

    rows = d1_client.query("SELECT run_id FROM strategy_mining_runs LIMIT 1")

    assert rows == [{"run_id": "run-1"}]
    assert observed["url"].endswith("/api/internal/strategy-mining/d1")
    assert observed["headers"]["Authorization"] == "Bearer dedicated-token"


def test_strategy_mining_worker_only_never_falls_back_to_raw_d1(monkeypatch):
    raw_called = False

    def fail_worker(*_args, **_kwargs):
        raise RuntimeError("worker unavailable")

    def raw_transport(*_args, **_kwargs):
        nonlocal raw_called
        raw_called = True
        return {}

    monkeypatch.setattr(d1_client, "STRATEGY_MINING_D1_WORKER_ONLY", True)
    monkeypatch.setattr(d1_client, "WORKER_URL", "https://worker.example.test")
    monkeypatch.setattr(d1_client, "WORKER_AUTH", "dedicated-token")
    monkeypatch.setattr(d1_client, "_worker_batch_execute", fail_worker)
    monkeypatch.setattr(d1_client, "_raw_batch_execute", raw_transport)

    with pytest.raises(d1_client.D1DurableBatchRetryRequired, match="worker_only=true"):
        d1_client.batch_execute([("UPDATE strategy_mining_runs SET status = ? WHERE run_id = ?", ["error", "run-1"])])

    assert raw_called is False


def test_strategy_mining_modal_app_isolated_from_broad_cloudflare_secret():
    repo_root = Path(__file__).resolve().parents[2]
    dedicated = (repo_root / "ml-service" / "modal_strategy_mining_app.py").read_text(encoding="utf-8")
    legacy = (repo_root / "ml-service" / "modal_app.py").read_text(encoding="utf-8")

    assert 'modal.App(name="stockvision-strategy-mining"' in dedicated
    assert 'modal.Secret.from_name("stockvision-strategy-mining")' in dedicated
    assert 'modal.Secret.from_name("stockvision-finlab")' in dedicated
    assert 'modal.Secret.from_name("gcs-credentials")' in dedicated
    assert '.add_local_dir(str(APP_DIR), remote_path="/root/app")' in dedicated
    assert "stockvision-cf" not in dedicated
    assert "CF_API_TOKEN" not in dedicated
    assert "STOCKVISION_AUTH_TOKEN" not in dedicated
    assert "def strategy_mining_research(payload" not in legacy
