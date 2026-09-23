from __future__ import annotations

import pytest

from routers import regime
from services import payload_builder


def test_regime_market_data_does_not_read_pipeline_serving_context(monkeypatch):
    run_date = "2026-09-23"

    def core_query(sql, _params):
        if "ORDER BY date DESC LIMIT 1" in sql:
            return [{"date": run_date, "risk_level": "yellow", "risk_score": 42}]
        return [{"date": run_date, "risk_level": "yellow", "risk_score": 42, "twii_close": 26000}]

    def blocked(*_args, **_kwargs):
        raise RuntimeError("pipeline serving context must remain gated separately")

    monkeypatch.setattr(payload_builder.CORE_D1_CLIENT, "query", core_query)
    monkeypatch.setattr(payload_builder.MARKET_D1_CLIENT, "query", lambda *_args: [])
    monkeypatch.setattr(payload_builder, "_load_market_symbol_price_rows", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(payload_builder.kv_client, "get_json", lambda *_args, **_kwargs: {})
    monkeypatch.setattr(payload_builder, "load_effective_adaptive_params", blocked)
    monkeypatch.setattr(payload_builder, "_load_lifecycle_weights_from_registry", blocked)
    monkeypatch.setattr(regime, "_enrich_market_env_with_finlab_macro_context", lambda env, _date: env)

    env = regime._fetch_market_env_via_payload_builder(run_date)

    assert env["requested_run_date"] == run_date
    assert env["risk_score"] == 42
    assert env["history"][run_date]["risk_score"] == 42
    with pytest.raises(RuntimeError, match="pipeline serving context"):
        payload_builder.load_market_env(run_date)
