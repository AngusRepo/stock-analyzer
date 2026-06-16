from __future__ import annotations

import pytest

from services import trading_config_loader as loader


def test_partial_kv_config_requires_explicit_offline_defaults(monkeypatch):
    monkeypatch.setattr(loader, "load_active_trading_config", lambda timeout=10.0, allow_offline=False: {})
    monkeypatch.setattr(
        loader,
        "get_raw_trading_config",
        lambda: {"ranking": {"topK": 5}, "ensemble_v2": {"buyThreshold": 0.68}},
    )

    with pytest.raises(loader.TradingConfigUnavailable):
        loader.load_merged_trading_config_with_contract()

    result = loader.load_merged_trading_config_with_contract(allow_offline_defaults=True)

    assert result.config["ranking"]["topK"] == 5
    assert result.config["ranking"]["enabled"] is True
    assert result.config["ensemble_v2"]["buyThreshold"] == 0.68
    assert result.config["mlPool"]["useEnsembleV2"] is True
    assert result.config["mlPool"]["degradedDampening"] == 0.1
    assert result.config["signal"]["buySignalScore"] == 0.52
    assert result.config["sltp"]["slMultBase"] == 2.0
    assert result.contract.degraded is True
    assert set(result.contract.missing_sections) >= {"mlPool", "alphaFramework", "signal", "sltp", "L2_formula"}
    assert result.contract.source == "offline_direct_kv_merged_required_defaults"


def test_worker_merged_config_is_preferred_and_raw_missing_sections_are_default_notes(monkeypatch):
    monkeypatch.setattr(
        loader,
        "get_raw_trading_config",
        lambda: {"ranking": {"topK": 4}},
    )
    monkeypatch.setattr(
        loader,
        "load_active_trading_config",
        lambda timeout=10.0, allow_offline=False: {
            "ranking": {"topK": 4, "enabled": True},
            "ensemble_v2": {"buyThreshold": 0.71},
            "mlPool": {"useEnsembleV2": True, "degradedDampening": 0.1},
            "alphaFramework": {"quality": {"minSamples": 40}},
            "signal": {"buySignalScore": 0.53},
            "sltp": {"slMultBase": 1.9},
            "L2_formula": {"confidence_risk_mult": 0.12},
        },
    )

    result = loader.load_merged_trading_config_with_contract()

    assert result.contract.source == "worker_admin_config"
    assert result.config["alphaFramework"]["quality"]["minSamples"] == 40
    assert result.config["signal"]["buySignalScore"] == 0.53
    assert result.contract.missing_sections == []
    assert "ensemble_v2" in result.contract.defaulted_sections
    assert result.contract.degraded is False


def test_full_worker_config_is_not_degraded(monkeypatch):
    full = {
        "ranking": {"topK": 3, "enabled": True},
        "ensemble_v2": {"buyThreshold": 0.70},
        "mlPool": {"useEnsembleV2": True, "degradedDampening": 0.1},
        "alphaFramework": {"quality": {"minSamples": 30}},
        "signal": {"buySignalScore": 0.52},
        "sltp": {"slMultBase": 2.0},
        "L2_formula": {"confidence_risk_mult": 0.15},
    }
    monkeypatch.setattr(loader, "get_raw_trading_config", lambda: full)
    monkeypatch.setattr(loader, "load_active_trading_config", lambda timeout=10.0, allow_offline=False: full)

    result = loader.load_merged_trading_config_with_contract()

    assert result.contract.degraded is False
    assert result.contract.missing_sections == []
    assert result.config["ensemble_v2"]["buyThreshold"] == 0.70


def test_worker_config_failure_is_not_silently_replaced_by_defaults(monkeypatch):
    monkeypatch.setattr(
        loader,
        "get_raw_trading_config",
        lambda: {
            "ranking": {"topK": 5},
            "ensemble_v2": {"buyThreshold": 0.68},
            "alphaFramework": {},
            "signal": {},
            "sltp": {},
            "L2_formula": {},
        },
    )

    def fail_worker(timeout=10.0, allow_offline=False):
        raise RuntimeError("worker unavailable")

    monkeypatch.setattr(loader, "load_active_trading_config", fail_worker)

    with pytest.raises(loader.TradingConfigUnavailable, match="Worker trading:config source unavailable"):
        loader.load_merged_trading_config_with_contract()


def test_full_raw_kv_config_can_be_used_only_when_worker_is_not_preferred(monkeypatch):
    full = {
        "ranking": {"topK": 3, "enabled": True},
        "ensemble_v2": {"buyThreshold": 0.70},
        "mlPool": {"useEnsembleV2": True, "degradedDampening": 0.1},
        "alphaFramework": {"quality": {"minSamples": 30}},
        "signal": {"buySignalScore": 0.52},
        "sltp": {"slMultBase": 2.0},
        "L2_formula": {"confidence_risk_mult": 0.15},
    }
    monkeypatch.setattr(loader, "get_raw_trading_config", lambda: full)

    result = loader.load_merged_trading_config_with_contract(prefer_worker=False)

    assert result.contract.source == "direct_kv_config"
    assert result.contract.degraded is False
    assert result.config["ranking"]["topK"] == 3
