from __future__ import annotations

import sys
import asyncio
import inspect
import types
from datetime import date, timedelta
from pathlib import Path

import pytest

graph_mod = types.ModuleType("langgraph.graph")
graph_mod.END = "__END__"


class _StateGraph:
    def __init__(self, *_args, **_kwargs):
        self.nodes = []

    def add_node(self, *args, **kwargs):
        self.nodes.append((args, kwargs))

    def set_entry_point(self, *_args, **_kwargs):
        return None

    def add_edge(self, *_args, **_kwargs):
        return None

    def compile(self, *_args, **_kwargs):
        return self

    async def ainvoke(self, initial_state):
        state = dict(initial_state)
        for args, _kwargs in self.nodes:
            node = args[1]
            update = node(state)
            if inspect.isawaitable(update):
                update = await update
            if not update:
                continue
            for key, value in update.items():
                if key == "errors" and key in state:
                    state[key] = [*state[key], *value]
                else:
                    state[key] = value
        return state


graph_mod.StateGraph = _StateGraph
types_mod = types.ModuleType("langgraph.types")


class _RetryPolicy:
    def __init__(self, **kwargs):
        self.kwargs = kwargs


types_mod.RetryPolicy = _RetryPolicy
httpx_mod = types.ModuleType("httpx")
httpx_mod.AsyncClient = object
httpx_mod.RequestError = Exception
httpx_mod.Timeout = lambda *_args, **_kwargs: None
sys.modules.setdefault("langgraph.graph", graph_mod)
sys.modules.setdefault("langgraph.types", types_mod)
sys.modules.setdefault("httpx", httpx_mod)

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs import daily_pipeline_v2  # noqa: E402
from services import modal_client  # noqa: E402


def test_state_space_overlay_daily_runtime_is_absent():
    source = Path(daily_pipeline_v2.__file__).read_text(encoding="utf-8")
    assert "def _state_space_overlay_mode" not in source
    assert "state_space_raw" not in source
    assert "state_space_overlay_mode" not in source
    assert "state_space_models" not in source


def test_deploy_manifest_retires_state_space_daily_compute():
    repo_root = Path(__file__).resolve().parents[2]
    deploy_source = (repo_root / "deploy_ml_controller.sh").read_text(encoding="utf-8")
    modal_source = (repo_root / "ml-service" / "modal_app.py").read_text(encoding="utf-8")
    assert "PIPELINE_STATE_SPACE_OVERLAY_MODE" not in deploy_source
    assert "PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS" not in deploy_source
    assert '"state_space_universal_predict": (_state_space, False)' not in modal_source
    assert '"state_space_raw"' not in modal_source
    assert "def state_space_universal_predict" in modal_source


def _run(coro):
    return asyncio.run(coro)


def _payload(symbol: str = "2330", *, price_count: int = 65) -> dict:
    start = date(2026, 1, 1)
    prices = []
    for idx in range(price_count):
        close = 100.0 + idx * 0.1
        prices.append({
            "date": (start + timedelta(days=idx)).isoformat(),
            "close": close,
            "adj_close": close,
        })
    return {
        "symbol": symbol,
        "stock_id": int(symbol),
        "prices": prices,
        "indicators": [],
        "stock_meta": {"market_segment": "LISTED"},
    }


def _feature_prediction(symbol: str = "2330") -> dict:
    return {
        "symbol": symbol,
        "stock_id": int(symbol),
        "signal": "BUY",
        "direction": "up",
        "confidence": 0.7,
        "rank_scores": {"XGBoost": 0.72, "ExtraTrees": 0.68},
    }


def _model_pool_status(overrides: dict[str, str] | None = None) -> dict[str, str]:
    status = {
        "LightGBM": "retired",
        "XGBoost": "retired",
        "ExtraTrees": "retired",
        "TabM": "retired",
        "GNN": "retired",
        "DLinear": "retired",
        "PatchTST": "retired",
        "iTransformer": "retired",
        "TimesFM": "retired",
        "KalmanFilter": "retired",
        "MarkovSwitching": "retired",
    }
    status.update(overrides or {})
    return status


def _patch_common(monkeypatch, *, state_space_result: dict | None = None, state_space_fn=None):
    async def fake_batch_predict(payloads):
        return [_feature_prediction(payload["symbol"]) for payload in payloads]

    async def empty_ts(*_args, **_kwargs):
        return {"results": []}

    async def fake_state_space(*_args, **_kwargs):
        return state_space_result or {"results": []}

    monkeypatch.setattr(daily_pipeline_v2, "batch_predict", fake_batch_predict)
    monkeypatch.setattr(modal_client, "dlinear_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "patchtst_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "itransformer_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "timesfm_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "gnn_graphsage_batch_predict", empty_ts)
    monkeypatch.setattr(modal_client, "state_space_overlays_batch_predict", state_space_fn or fake_state_space)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            _model_pool_status({"KalmanFilter": "active", "MarkovSwitching": "active"}),
            {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
            {},
            True,
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_pool_and_ic",
        lambda: (
            {"XGBoost": "active"},
            {},
            1.0,
            {},
            True,
            {
                "models": {
                    "XGBoost": {
                        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
                    },
                },
            },
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_resolve_runtime_regime_contract",
        lambda *_args, **_kwargs: {"regime": "sideways", "source": "test"},
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "load_threshold_policy_snapshot",
        lambda **_kwargs: {},
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "resolve_ml_threshold_policy",
        lambda **_kwargs: types.SimpleNamespace(
            policy_id="test-policy",
            version="v1",
            selected_regime="sideways",
            evidence_hash="test-hash",
        ),
    )

    def fake_attach(row, *_args, **_kwargs):
        row["ensemble_v2"] = {
            "avg_rank": 0.7,
            "signal": row.get("signal", "HOLD"),
            "contributing_models": ["XGBoost"],
        }

    monkeypatch.setattr(daily_pipeline_v2, "_attach_ensemble_v2", fake_attach)


def _retired_test_state_space_shadow_mode_spawns_without_blocking_prediction(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "shadow")
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example.test")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "service-token")
    spawn_calls = []

    def fake_spawn(
        series_list,
        *,
        horizon=5,
        version_by_model=None,
        run_date=None,
        run_id=None,
        callback_url=None,
        callback_token=None,
    ):
        spawn_calls.append({
            "n": len(series_list),
            "horizon": horizon,
            "version_by_model": version_by_model,
            "run_date": run_date,
            "run_id": run_id,
            "callback_url": callback_url,
            "callback_token": callback_token,
        })
        return {"spawned": True, "function_call_id": "fc-123", "n_input": len(series_list)}

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "spawn_state_space_overlays_batch_predict", fake_spawn)

    result = _run(daily_pipeline_v2.node_ml_predict({"run_date": "2026-03-06", "payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert spawn_calls == [{
        "n": 1,
        "horizon": 5,
        "version_by_model": {"KalmanFilter": "v1", "MarkovSwitching": "v1"},
        "run_date": "2026-03-06",
        "run_id": None,
        "callback_url": "https://worker.example.test/api/internal/state-space-shadow/callback",
        "callback_token": "service-token",
    }]


def _retired_test_state_space_blocking_mode_preserves_overlay_attachment(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "blocking")
    state_space_result = {
        "overlays": {
            "KalmanFilter": {
                "results": [{"symbol": "2330", "forecast_pct": 0.01, "confidence": 0.6}],
            },
            "MarkovSwitching": {
                "results": [{"symbol": "2330", "forecast_pct": -0.01, "confidence": 0.55}],
            },
        },
        "metrics": {},
    }
    _patch_common(monkeypatch, state_space_result=state_space_result)

    result = _run(daily_pipeline_v2.node_ml_predict({"run_date": "2026-03-06", "payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["kalman_filter"]["forecast_pct"] == 0.01
    assert pred["markov_switching"]["forecast_pct"] == -0.01


def _retired_test_state_space_soft_deadline_continues_without_overlay(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "blocking")
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_SOFT_DEADLINE_SECONDS", "0.01")
    calls = []

    async def slow_state_space(series_list, *_args, **_kwargs):
        calls.append(len(series_list))
        await asyncio.sleep(0.2)
        return {
            "overlays": {
                "KalmanFilter": {"results": [{"symbol": "2330", "forecast_pct": 0.01}]},
                "MarkovSwitching": {"results": [{"symbol": "2330", "forecast_pct": -0.01}]},
            },
            "metrics": {},
        }

    _patch_common(monkeypatch, state_space_fn=slow_state_space)

    result = _run(daily_pipeline_v2.node_ml_predict({"run_date": "2026-03-06", "payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["signal"] == "BUY"
    assert "kalman_filter" not in pred
    assert "markov_switching" not in pred
    assert calls == [1]


def _retired_test_gnn_full_universe_scores_attach_to_rank_scores(monkeypatch):
    async def fake_gnn(payloads, *_args, **_kwargs):
        return {
            "results": [
                {"symbol": payloads[0]["symbol"], "rank_score": 0.81, "graph_context": {"n_nodes": len(payloads)}}
            ],
            "n_input": len(payloads),
            "n_success": 1,
        }

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "gnn_graphsage_batch_predict", fake_gnn)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            _model_pool_status({"GNN": "active"}),
            {"GNN": "v1"},
            {},
            True,
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_pool_and_ic",
        lambda: (
            {"XGBoost": "active", "GNN": "active"},
            {},
            1.0,
            {},
            True,
            {
                "models": {
                    name: {
                        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
                    }
                    for name in ("XGBoost", "GNN")
                },
            },
        ),
    )

    result = _run(daily_pipeline_v2.node_ml_predict({"run_date": "2026-03-06", "payloads": [_payload()]}))

    pred = result["predictions"]["2330"]
    assert pred["gnn"]["graph_context"]["n_nodes"] == 1
    assert pred["raw_model_scores"]["GNN"] == 0.81
    assert "GNN" not in pred["rank_scores"]
    assert "rank_missing:GNN" in pred["model_score_lineage"]["blockers"]
    assert result["modal_wait_telemetry"]["stage_timings"]["gnn_graphsage_universal_predict"]["required_alpha"] is True


def test_timesfm_l2_sidecar_status_merge_preserves_canonical_active_status():
    merged = daily_pipeline_v2._merge_model_status_preserving_sidecars(
        {"TimesFM": "active", "DLinear": "active"},
        {"TimesFM": "retired", "DLinear": "degraded"},
    )

    assert merged["TimesFM"] == "active"
    assert merged["DLinear"] == "degraded"


def _retired_test_timesfm_gate_requires_coverage_and_blocks_direct_alpha(monkeypatch):
    monkeypatch.setenv("TIMESFM_SEQUENCE_CONTRACT_POINTS", "128")
    series = [{"symbol": "2330", "prices": list(range(260))}]
    pool = {"l2_feature_sidecars": {"TimesFM": {"status": "active", "version": "v1"}}}

    allowed, meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool=pool,
        ev2_cfg={},
        sequence_series=series,
    )

    assert allowed is True
    assert meta["reason"] == "timesfm_l2_sidecar_sequence_contract_ok"
    assert meta["ensemble_contribution_allowed"] is False
    assert meta["direct_alpha_blocked"] is True
    assert meta["sequence_contract_points"] == 128
    assert meta["effective_weight"] == 0.0

    short_series = [{"symbol": "2330", "prices": list(range(60))}]
    blocked, blocked_meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool=pool,
        ev2_cfg={},
        sequence_series=short_series,
    )

    assert blocked is False
    assert blocked_meta["reason"] == "timesfm_sequence_contract_unmet"
    assert blocked_meta["coverage"]["min_points"] == 128

    mixed_series = [
        {"symbol": "2330", "prices": list(range(260))},
        {"symbol": "2317", "prices": list(range(60))},
    ]
    allowed, meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool=pool,
        ev2_cfg={},
        sequence_series=mixed_series,
    )

    assert allowed is True
    assert meta["sequence_contract_mode"] == "per_symbol_subset"
    assert meta["coverage"]["total"] == 2
    assert meta["coverage"]["usable"] == 1
    assert meta["coverage"]["excluded_count"] == 1
    assert meta["coverage"]["excluded_symbols"] == [
        {"symbol": "2317", "points": 60, "reason": "insufficient_sequence_points"}
    ]


def _retired_test_timesfm_gate_requires_artifact_sequence_contract_when_active(monkeypatch):
    monkeypatch.delenv("TIMESFM_SEQUENCE_CONTRACT_POINTS", raising=False)

    with pytest.raises(RuntimeError, match="TimesFM L2 sidecar missing gcs_path/version"):
        daily_pipeline_v2._timesfm_sync_gate(
            model_status={"TimesFM": "active"},
            pool={"l2_feature_sidecars": {"TimesFM": {"status": "active"}}},
            ev2_cfg={},
            sequence_series=[],
        )


def _retired_test_timesfm_gate_accepts_l2_sidecar_sequence_contract(monkeypatch):
    monkeypatch.setenv("TIMESFM_SEQUENCE_CONTRACT_POINTS", "128")
    series = [{"symbol": "2330", "prices": list(range(128))}]
    pool = {
        "l2_feature_sidecars": {
            "TimesFM": {
                "status": "active",
                "version": "v1",
                "role": "l2_feature_sidecar",
            }
        }
    }

    allowed, meta = daily_pipeline_v2._timesfm_sync_gate(
        model_status={"TimesFM": "active"},
        pool=pool,
        ev2_cfg={},
        sequence_series=series,
    )

    assert allowed is True
    assert meta["reason"] == "timesfm_l2_sidecar_sequence_contract_ok"
    assert meta["ensemble_contribution_allowed"] is False
    assert meta["direct_alpha_blocked"] is True
    assert meta["sequence_contract_points"] == 128
    assert meta["diagnostic"]["source"] == "l2_feature_sidecar"


def _retired_test_timesfm_modal_call_uses_sequence_contract_subset(monkeypatch):
    monkeypatch.setenv("TIMESFM_SEQUENCE_CONTRACT_POINTS", "60")
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "disabled")
    calls = []

    async def fake_timesfm(series_list, *_args, **kwargs):
        calls.append({
            "symbols": [row["symbol"] for row in series_list],
            "sequence_contract_points": kwargs.get("sequence_contract_points"),
        })
        return {
            "results": [
                {"symbol": row["symbol"], "forecast_pct": 0.02, "confidence": 0.63}
                for row in series_list
            ],
        }

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "timesfm_batch_predict", fake_timesfm)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            _model_pool_status({"TimesFM": "active"}),
            {"TimesFM": "v1"},
            {},
            True,
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_pool_and_ic",
        lambda: (
            {"TimesFM": "active"},
            {},
            1.0,
            {},
            True,
            {"l2_feature_sidecars": {"TimesFM": {"status": "active", "version": "v1"}}},
        ),
    )

    result = _run(daily_pipeline_v2.node_l2_timesfm_enrich({
        "run_date": "2026-03-06",
        "payloads": [
            _payload("2330", price_count=65),
            _payload("2317", price_count=20),
        ]
    }))

    assert calls == [{"symbols": ["2330"], "sequence_contract_points": 60}]
    assert "2330" in result["timesfm_l2_sidecars"]
    assert "2317" not in result["timesfm_l2_sidecars"]
    gate = result["timesfm_l2_summary"]["gate"]
    assert gate["allowed"] is True
    assert gate["coverage"]["usable"] == 1
    assert gate["coverage"]["excluded_count"] == 1


def _retired_test_sequence_family_models_use_sequence_contract_subset(monkeypatch):
    monkeypatch.setenv("PIPELINE_STATE_SPACE_OVERLAY_MODE", "disabled")
    calls = []

    async def fake_dlinear(series_list, *_args, **_kwargs):
        calls.append([row["symbol"] for row in series_list])
        return {
            "results": [
                {"symbol": row["symbol"], "forecast_pct": 0.02, "confidence": 0.63}
                for row in series_list
            ],
        }

    _patch_common(monkeypatch)
    monkeypatch.setattr(modal_client, "dlinear_batch_predict", fake_dlinear)
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_model_pool_versions",
        lambda: (
            _model_pool_status({"DLinear": "active"}),
            {"DLinear": "v1"},
            {},
            True,
        ),
    )
    monkeypatch.setattr(
        daily_pipeline_v2,
        "_load_pool_and_ic",
        lambda: (
            {"XGBoost": "active", "DLinear": "active"},
            {},
            1.0,
            {},
            True,
            {
                "models": {
                    "XGBoost": {
                        "target_semantic_version": "next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4",
                    },
                    "DLinear": {
                        "version": "v1",
                        "serving_artifact_id": "DLinear:v1:oof_full_fit_release",
                        "sequence_contract": {
                            "schema_version": "model-serving-sequence-contract-v1",
                            "source": "model_artifact_registry",
                            "model": "DLinear",
                            "artifact_id": "DLinear:v1:oof_full_fit_release",
                            "version": "v1",
                            "seq_len": 512,
                            "pred_len": 5,
                        },
                    },
                },
            },
        ),
    )

    result = _run(daily_pipeline_v2.node_ml_predict({
        "run_date": "2026-03-06",
        "payloads": [
            _payload("2330", price_count=1030),
            _payload("2317", price_count=20),
        ]
    }))

    assert calls == [["2330"]]
    assert "dlinear" in result["predictions"]["2330"]
    assert "dlinear" not in result["predictions"]["2317"]
    sequence_meta = result["modal_wait_telemetry"]["sequence_dataset"]
    dlinear = sequence_meta["sequence_model_contracts"]["DLinear"]
    assert dlinear["seq_len"] == 512
    assert dlinear["usable"] == 1
    assert dlinear["excluded_count"] == 1


def test_sequence_contract_is_resolved_per_serving_artifact():
    contracts = daily_pipeline_v2._sequence_model_contracts(
        pool={
            "models": {
                "DLinear": {
                    "version": "d1",
                    "serving_artifact_id": "DLinear:d1:oof_full_fit_release",
                    "sequence_contract": {
                        "schema_version": "model-serving-sequence-contract-v1",
                        "source": "model_artifact_registry",
                        "model": "DLinear",
                        "artifact_id": "DLinear:d1:oof_full_fit_release",
                        "version": "d1",
                        "seq_len": 512,
                        "pred_len": 5,
                    },
                },
                "PatchTST": {
                    "version": "p1",
                    "serving_artifact_id": "PatchTST:p1:oof_full_fit_release",
                    "sequence_contract": {
                        "schema_version": "model-serving-sequence-contract-v1",
                        "source": "model_artifact_registry",
                        "model": "PatchTST",
                        "artifact_id": "PatchTST:p1:oof_full_fit_release",
                        "version": "p1",
                        "seq_len": 768,
                        "pred_len": 5,
                    },
                },
                "iTransformer": {
                    "version": "i1",
                    "serving_artifact_id": "iTransformer:i1:oof_full_fit_release",
                    "sequence_contract": {
                        "schema_version": "model-serving-sequence-contract-v1",
                        "source": "model_artifact_registry",
                        "model": "iTransformer",
                        "artifact_id": "iTransformer:i1:oof_full_fit_release",
                        "version": "i1",
                        "seq_len": 1024,
                        "pred_len": 5,
                    },
                },
            },
        },
        model_status={
            "DLinear": "active",
            "PatchTST": "active",
            "iTransformer": "degraded",
        },
    )
    assert {name: row["seq_len"] for name, row in contracts.items()} == {
        "DLinear": 512,
        "PatchTST": 768,
        "iTransformer": 1024,
    }
    assert {name: row["pred_len"] for name, row in contracts.items()} == {
        "DLinear": 5,
        "PatchTST": 5,
        "iTransformer": 5,
    }


def test_sequence_contract_rejects_stale_artifact_identity():
    with pytest.raises(RuntimeError, match="version-bound sequence contract"):
        daily_pipeline_v2._sequence_model_contracts(
            pool={
                "models": {
                    "DLinear": {
                        "version": "vNew",
                        "serving_artifact_id": "DLinear:vNew:oof_full_fit_release",
                        "sequence_contract": {
                            "schema_version": "model-serving-sequence-contract-v1",
                            "source": "model_artifact_registry",
                            "model": "DLinear",
                            "artifact_id": "DLinear:vOld:oof_full_fit_release",
                            "version": "vOld",
                            "seq_len": 1024,
                            "pred_len": 5,
                        },
                    }
                }
            },
            model_status={"DLinear": "active"},
        )
