from __future__ import annotations

import asyncio
import ast
from pathlib import Path
from typing import Any

import pytest
from fastapi import HTTPException

from routers import regime
from routers.regime import _request_regime_current


class _Response:
    def __init__(self, status_code: int, payload: dict[str, Any] | None = None, text: str = ""):
        self.status_code = status_code
        self._payload = payload or {}
        self.text = text

    def json(self) -> dict[str, Any]:
        return self._payload


class _Client:
    def __init__(self, responses: list[_Response]):
        self.responses = list(responses)
        self.calls = 0

    async def post(self, *_args: Any, **_kwargs: Any) -> _Response:
        response = self.responses[self.calls]
        self.calls += 1
        return response


def _run(client: _Client) -> dict[str, Any]:
    return asyncio.run(_request_regime_current(
        client,  # type: ignore[arg-type]
        market_env={"history": {"2026-08-03": {}}},
        force_retrain=False,
        headers={"Content-Type": "application/json"},
        request_id="test-request",
        retry_delay_seconds=0,
    ))


def test_regime_current_retries_modal_408_once_then_closes():
    client = _Client([
        _Response(408, text="request timeout"),
        _Response(200, payload={"regime_label_en": "sideways"}),
    ])

    assert _run(client)["regime_label_en"] == "sideways"
    assert client.calls == 2


def test_regime_current_does_not_retry_non_transient_400():
    client = _Client([_Response(400, text="bad PIT payload")])

    with pytest.raises(HTTPException) as exc_info:
        _run(client)

    assert exc_info.value.status_code == 502
    assert "HTTP 400" in str(exc_info.value.detail)
    assert client.calls == 1


def test_modal_regime_to_thread_has_runtime_asyncio_import():
    source_path = Path(__file__).parents[2] / "ml-service" / "app" / "main.py"
    source = source_path.read_text(encoding="utf-8-sig")
    module = ast.parse(source)
    imported_names = {
        alias.name
        for node in module.body
        if isinstance(node, ast.Import)
        for alias in node.names
    }
    assert "asyncio" in imported_names
    assert "await asyncio.to_thread(_compute_regime_current, req)" in source


def test_effective_regime_uses_its_own_policy_after_bear_guard(monkeypatch):
    captured: dict[str, Any] = {}
    monkeypatch.setattr(regime, "ML_SERVICE_URL", "https://ml.invalid")
    monkeypatch.setattr(regime, "_fetch_market_env_via_payload_builder", lambda _date: {
        "history": {"2026-10-02": {}},
        "requested_run_date": "2026-10-02",
        "market_proxy_latest_date": "2026-10-02",
    })

    async def fake_current(*_args: Any, **_kwargs: Any) -> dict[str, Any]:
        return {
            "regime_label_en": "bear_market",
            "regime_index": 3,
            "hmm_state": 0,
            "feature_date": "2026-10-02",
            "regime_surface": {"bull_market": 0.0, "volatile": 0.0, "sideways": 0.0, "bear_market": 1.0},
            "consensus_threshold": 0.72,
            "weight_multipliers": {"XGBoost": 0.75},
            "regime_policies": {
                "sideways": {"label": "震盪整理", "consensus_threshold": 0.68, "weight_multipliers": {"XGBoost": 0.85}},
            },
            "semantic_mapping_version": "emission_direction_vol_v2",
            "state_semantic_map": {"0": 3},
        }

    monkeypatch.setattr(regime, "_request_regime_current", fake_current)
    monkeypatch.setattr(regime, "build_regime_evidence_pack", lambda *_args, **_kwargs: {
        "effective_label": "sideways", "transition_guard": {}, "monitors": {},
    })
    monkeypatch.setattr(regime, "push_optuna_result", lambda **kwargs: captured.update(kwargs) or {"success": True})

    result = asyncio.run(regime.regime_compute(regime.RegimeComputeRequest(run_date="2026-10-02")))

    assert result["regime_label_en"] == "sideways"
    assert result["regime_index"] == 2
    assert result["label_zh"] == "震盪整理"
    assert captured["params"]["regime_index"] == 2
    assert captured["params"]["regime_evidence"]["hmm_raw_regime_index"] == 3
    assert captured["params"]["consensus_threshold"] == 0.68
    assert captured["params"]["weight_multipliers"] == {"XGBoost": 0.85}
    assert captured["params"]["regime_surface"] == {
        "bull_market": 0.0, "volatile": 0.0, "sideways": 1.0, "bear_market": 0.0,
    }
    assert captured["params"]["regime_evidence"]["hmm_raw_regime_surface"]["bear_market"] == 1.0
    assert captured["params"]["regime_evidence"]["hmm_semantic_mapping_version"] == "emission_direction_vol_v2"


def test_transition_guard_preserves_other_posterior_mass():
    raw = {"bull_market": 0.1, "volatile": 0.2, "sideways": 0.0, "bear_market": 0.7}
    assert regime._apply_transition_guard_to_surface(raw, "bear_market", "sideways") == {
        "bull_market": 0.1, "volatile": 0.2, "sideways": 0.7, "bear_market": 0.0,
    }
    assert raw["bear_market"] == 0.7
