from __future__ import annotations

import sys
import types
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

google_cloud = sys.modules.setdefault("google.cloud", types.ModuleType("google.cloud"))
if not hasattr(google_cloud, "run_v2"):
    run_v2_stub = types.SimpleNamespace(JobsClient=object, ExecutionsClient=object)
    setattr(google_cloud, "run_v2", run_v2_stub)
    sys.modules.setdefault("google.cloud.run_v2", run_v2_stub)

from routers import optuna  # noqa: E402
from services import trading_config_loader  # noqa: E402


def _cfg_result(config: dict) -> SimpleNamespace:
    return SimpleNamespace(
        config=config,
        contract=SimpleNamespace(degraded=False, to_dict=lambda: {"degraded": False}),
    )


def test_alpha_framework_route_returns_and_pushes_risk_overlay_evidence(monkeypatch):
    captured: dict = {}
    evidence = {
        "method": "posterior_numeric_outcome_distribution",
        "numeric_sample_counts": {"volatility": 42},
        "adaptive_fields": ["alphaFramework.riskOverlay.highVolThreshold"],
        "fallback_fields": [],
    }

    monkeypatch.setattr(
        trading_config_loader,
        "load_merged_trading_config_with_contract",
        lambda: _cfg_result({"alphaFramework": {"quality": {
            "outcomeLimit": 900,
            "minSamples": 40,
            "minRegimeSamples": 7,
            "minBucketSamples": 5,
            "posteriorFullConfidenceSamples": 11,
            "posteriorWeightImpactBps": 1500,
            "minBucketWeightBps": 250,
            "returnPctPerRBps": 300,
            "directionCorrectFallbackRBps": 1250,
        }}}),
    )
    monkeypatch.setattr(optuna, "load_alpha_outcome_rows", lambda limit: [{"id": 1}] * 42)
    def fake_build(rows, **kwargs):
        captured["build_kwargs"] = kwargs
        return {
            "status": "completed",
            "alphaFramework": {
                "riskOverlay": {"highVolThreshold": 0.042},
                "allocation": {"slateSize": 10, "weights": {}},
            },
            "sample_count": len(rows),
            "regime_counts": {"bull": 10},
            "bucket_counts": {"trend_following": 10},
            "skipped_count": 2,
            "risk_overlay_evidence": evidence,
        }

    monkeypatch.setattr(optuna, "build_alpha_policy_candidate", fake_build)

    def fake_push(*, source, params, meta):
        captured["source"] = source
        captured["params"] = params
        captured["meta"] = meta
        return {"success": True, "sandbox_id": "sandbox-1"}

    monkeypatch.setattr(optuna, "push_optuna_result", fake_push)

    out = optuna.run_alpha_framework(optuna.OptunaReq(push_kv=True, dry_run=False, subset_size=500))

    assert out["status"] == "completed"
    assert out["risk_overlay_evidence"] == evidence
    assert captured["source"] == "alpha_framework"
    assert captured["meta"]["risk_overlay_evidence"] == evidence
    assert captured["build_kwargs"] == {
        "min_samples": 40,
        "min_regime_samples": 7,
        "min_bucket_samples": 5,
        "posterior_full_confidence_samples": 11,
        "posterior_weight_impact": 0.15,
        "min_bucket_weight": 0.025,
        "return_pct_per_r": 0.03,
        "direction_correct_fallback_r": 0.125,
    }


def test_alpha_framework_route_uses_quality_outcome_limit_when_subset_omitted(monkeypatch):
    captured: dict = {}

    monkeypatch.setattr(
        trading_config_loader,
        "load_merged_trading_config_with_contract",
        lambda: _cfg_result({"alphaFramework": {"quality": {"outcomeLimit": 777, "minSamples": 3, "minBucketSamples": 2}}}),
    )
    def fake_load(limit):
        captured["limit"] = limit
        return [{"id": 1}] * 3

    monkeypatch.setattr(optuna, "load_alpha_outcome_rows", fake_load)
    monkeypatch.setattr(
        optuna,
        "build_alpha_policy_candidate",
        lambda rows, **kwargs: {
            "status": "completed",
            "alphaFramework": {"riskOverlay": {}, "allocation": {"weights": {}}},
            "sample_count": len(rows),
        },
    )

    out = optuna.run_alpha_framework(optuna.AlphaFrameworkOptunaReq(push_kv=False, dry_run=True))

    assert out["status"] == "completed"
    assert captured["limit"] == 777


def test_ga_optimizer_route_pushes_learning_state(monkeypatch):
    captured: dict = {}

    def fake_run(req):
        captured["req"] = req
        return {
            "status": "completed",
            "optimizer": "GAOptimizer",
            "population_size": req.population_size,
            "generations": req.generations,
            "best": {
                "score": 1.23,
                "gate": {"decision": "PASS", "passed": True},
                "plateau": {"plateau_size": 2},
                "candidate": {
                    "target": "meta_optimizer_learning",
                    "params": {
                        "alphaFramework": {
                            "riskOverlay": {"highVolThreshold": 0.045},
                            "allocation": {"weights": {"bull": {"trend_following": 0.5}}},
                        }
                    },
                },
            },
            "ranked": [],
            "contract": {"applies_to_production": False, "push_target": "worker_kv_ga_optimizer_state"},
        }

    def fake_push(*, source, params, meta):
        captured["source"] = source
        captured["params"] = params
        captured["meta"] = meta
        return {"success": True, "sandbox_id": "ga-1"}

    monkeypatch.setattr(optuna, "run_ga_optimizer_service", fake_run)
    monkeypatch.setattr(optuna, "push_optuna_result", fake_push)

    out = optuna.run_ga_optimizer(
        optuna.GAOptimizerReq(
            population_size=12,
            generations=4,
            push_kv=True,
            dry_run=False,
        )
    )

    assert out["status"] == "completed"
    assert out["source"] == "ga_optimizer"
    assert out["contract"]["scope"] == "production_meta_optimizer_learning"
    assert out["contract"]["applies_to_production"] == "learning_state_only_until_gated_promotion"
    assert out["contract"]["push_target"] == "worker_kv_ga_optimizer_state"
    assert captured["source"] == "ga_optimizer"
    assert captured["params"]["status"] == "learning"
    assert captured["params"]["best_alphaFramework"]["riskOverlay"]["highVolThreshold"] == 0.045
    assert captured["meta"]["optimizer"] == "GAOptimizer"

def test_worker_push_contract_uses_actual_worker_target():
    sandbox = {"success": True, "target": "sandbox", "sandbox_id": "sandbox-1"}
    production = {"success": True, "target": "prod", "snapshot_id": "snapshot-1"}

    assert optuna._worker_push_target(sandbox) == "worker_kv_sandbox"
    assert optuna._worker_push_scope(sandbox) == "sandbox_challenger"
    assert optuna._worker_push_applies_to_production(sandbox) is False

    assert optuna._worker_push_target(production) == "worker_kv_production"
    assert optuna._worker_push_scope(production) == "production_bound"
    assert optuna._worker_push_applies_to_production(production) is True


def test_worker_push_contract_fails_closed_for_missing_or_unsuccessful_response():
    for response in (None, {}, {"success": False, "target": "prod"}):
        assert optuna._worker_push_target(response) == "not_pushed"
        assert optuna._worker_push_scope(response) == "research_only"
        assert optuna._worker_push_applies_to_production(response) is False


def test_worker_push_contract_recognizes_legacy_sandbox_response():
    response = {"success": True, "sandbox_id": "sandbox-legacy"}

    assert optuna._worker_push_target(response) == "worker_kv_sandbox"
    assert optuna._worker_push_scope(response) == "sandbox_challenger"
    assert optuna._worker_push_applies_to_production(response) is False

def test_per_regime_run_triggers_cloud_run_job_with_queue_identity(monkeypatch):
    captured: dict = {}

    def fake_run_job(*, env_overrides):
        captured["env"] = env_overrides
        return SimpleNamespace(
            execution_id="optuna-research-sweep-abc",
            execution_name="projects/p/locations/asia-east1/jobs/optuna/executions/optuna-research-sweep-abc",
        )

    monkeypatch.setattr(optuna._optuna_jobs_client, "run_job", fake_run_job)
    out = optuna.trigger_per_regime_job(optuna.PerRegimeReq(
        target="sltp",
        n_trials=50,
        subset_size=200,
        window_days=365,
        push_kv=True,
        dry_run=False,
        cadence="queue",
        research_data_source="snapshot",
        trigger_source="regime_change",
        trigger_id="per_regime:regime_shift:volatile:2026-07-22",
    ))

    assert out["status"] == "triggered"
    assert out["task"] == "optuna-per-regime"
    assert out["execution_id"] == "optuna-research-sweep-abc"
    assert out["run_date"] == "2026-07-22"
    assert "callback expected" in out["message"]
    assert captured["env"] == {
        "OPTUNA_JOB_MODE": "per_regime",
        "OPTUNA_PER_REGIME_TARGET": "sltp",
        "OPTUNA_N_TRIALS": "50",
        "OPTUNA_SUBSET_SIZE": "200",
        "OPTUNA_WINDOW_DAYS": "365",
        "OPTUNA_CADENCE": "queue",
        "OPTUNA_RESEARCH_DATA_SOURCE": "snapshot",
        "OPTUNA_PUSH_KV": "1",
        "OPTUNA_DRY_RUN": "0",
        "OPTUNA_TRIGGER_SOURCE": "regime_change",
        "OPTUNA_QUEUE_ENTRY_ID": "per_regime:regime_shift:volatile:2026-07-22",
        "OPTUNA_RUN_DATE": "2026-07-22",
    }


def test_optuna_job_entrypoint_has_per_regime_callback_contract():
    source = (Path(__file__).resolve().parent.parent / "optuna_job_main.py").read_text(encoding="utf-8")

    assert 'OPTUNA_JOB_MODE' in source
    assert 'task = "optuna-per-regime"' in source
    assert 'queue_entry_id' in source
    assert 'sandbox_id' in source
    assert 'await _callback_worker(payload)' in source

def test_monthly_global_sweep_excludes_standalone_s12_calibration_owner(monkeypatch):
    calls: list[str] = []

    def fake_result(source: str):
        def run(_req):
            calls.append(source)
            return {"status": "completed", "source": source, "contract": {}, "push": None}
        return run

    for source, name in (
        ("barrier", "run_barrier"),
        ("signal", "run_signal"),
        ("sltp", "run_sltp"),
        ("screener", "run_screener"),
        ("conformal", "run_conformal"),
        ("risk_params", "run_risk_params"),
        ("rrg", "run_rrg"),
        ("alpha_framework", "run_alpha_framework"),
        ("ga_optimizer", "run_ga_optimizer"),
    ):
        monkeypatch.setattr(optuna, name, fake_result(source))
    monkeypatch.setattr(
        optuna,
        "run_s12_smcvwap_tw",
        lambda _req: (_ for _ in ()).throw(AssertionError("S12 must use its standalone calibration owner")),
    )

    out = optuna.execute_research_sweep(optuna.OptunaResearchSweepReq(
        cadence="monthly",
        n_trials=5,
        subset_size=100,
        max_parallel_sources=1,
        push_kv=False,
        dry_run=True,
    ))

    assert out["status"] == "completed"
    assert calls == [
        "barrier",
        "signal",
        "sltp",
        "screener",
        "conformal",
        "risk_params",
        "rrg",
        "alpha_framework",
        "ga_optimizer",
    ]
    assert "s12_smcvwap_tw" not in {item["source"] for item in out["results"]}



def test_research_sweep_two_phase_commit_stages_once_after_all_sources_succeed(monkeypatch):
    calls: list[tuple[str, object]] = []
    pushes: list[dict] = []

    def fake_result(source: str):
        def run(req):
            calls.append((source, req))
            result = {
                "status": "completed",
                "source": source,
                "best_params": {"value": source},
                "contract": {},
                "push": None,
            }
            if source == "screener":
                result["resolved_screener"] = {"minPrice": 20}
            if source == "ga_optimizer":
                result["learning_state"] = {"optimizer": "GAOptimizer", "best": {"score": 1.2}}
            return result
        return run

    for source, name in (
        ("barrier", "run_barrier"),
        ("signal", "run_signal"),
        ("sltp", "run_sltp"),
        ("screener", "run_screener"),
        ("conformal", "run_conformal"),
        ("risk_params", "run_risk_params"),
        ("rrg", "run_rrg"),
        ("alpha_framework", "run_alpha_framework"),
        ("ga_optimizer", "run_ga_optimizer"),
    ):
        monkeypatch.setattr(optuna, name, fake_result(source))

    def fake_push(**kwargs):
        pushes.append(kwargs)
        if kwargs["source"] == "research_sweep":
            return {
                "success": True,
                "target": "sandbox",
                "sandbox_id": "trading:config:sandbox:research_sweep:test",
                "candidate_record": {
                    "candidate_id": "parameter:research_sweep:test",
                    "status": "SHADOW_COLLECTING",
                },
            }
        return {"success": True, "target": "production_meta_optimizer_learning_state"}

    monkeypatch.setattr(optuna, "push_optuna_result", fake_push)
    monkeypatch.setenv("CLOUD_RUN_EXECUTION", "execution-two-phase")

    out = optuna.execute_research_sweep(optuna.OptunaResearchSweepReq(
        cadence="monthly",
        n_trials=5,
        subset_size=100,
        max_parallel_sources=1,
        push_kv=True,
        dry_run=False,
    ))

    assert out["status"] == "completed"
    assert out["staging"]["status"] == "staged"
    assert [item["source"] for item in pushes] == ["research_sweep", "ga_optimizer"]
    assert pushes[0]["params"]["sources"]["screener"] == {"minPrice": 20}
    assert pushes[0]["meta"]["run_id"] == "execution-two-phase"
    assert all(req.push_kv is False and req.dry_run is True for _, req in calls)


def test_research_sweep_failure_performs_zero_pushes(monkeypatch):
    pushes: list[dict] = []

    def fake_result(source: str):
        def run(_req):
            if source == "signal":
                raise RuntimeError("signal failed")
            result = {
                "status": "completed",
                "source": source,
                "best_params": {"value": source},
                "contract": {},
                "push": None,
            }
            if source == "screener":
                result["resolved_screener"] = {"minPrice": 20}
            if source == "ga_optimizer":
                result["learning_state"] = {"optimizer": "GAOptimizer"}
            return result
        return run

    for source, name in (
        ("barrier", "run_barrier"),
        ("signal", "run_signal"),
        ("sltp", "run_sltp"),
        ("screener", "run_screener"),
        ("conformal", "run_conformal"),
        ("risk_params", "run_risk_params"),
        ("rrg", "run_rrg"),
        ("alpha_framework", "run_alpha_framework"),
        ("ga_optimizer", "run_ga_optimizer"),
    ):
        monkeypatch.setattr(optuna, name, fake_result(source))

    monkeypatch.setattr(optuna, "push_optuna_result", lambda **kwargs: pushes.append(kwargs))

    out = optuna.execute_research_sweep(optuna.OptunaResearchSweepReq(
        cadence="monthly",
        n_trials=5,
        subset_size=100,
        max_parallel_sources=1,
        push_kv=True,
        dry_run=False,
    ))

    assert out["status"] == "error"
    assert out["staging"]["status"] == "blocked"
    assert out["staging"]["reason"] == "source_failure"
    assert pushes == []
