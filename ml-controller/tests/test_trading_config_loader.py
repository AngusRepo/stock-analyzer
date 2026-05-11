from __future__ import annotations

from services import trading_config_loader as loader


def test_partial_kv_config_is_merged_with_required_defaults(monkeypatch):
    monkeypatch.setattr(loader, "load_active_trading_config", lambda timeout=10.0: {})
    monkeypatch.setattr(
        loader,
        "get_raw_trading_config",
        lambda: {"ranking": {"topK": 5}, "ensemble_v2": {"buyThreshold": 0.68}},
    )

    result = loader.load_merged_trading_config_with_contract()

    assert result.config["ranking"]["topK"] == 5
    assert result.config["ranking"]["enabled"] is True
    assert result.config["ensemble_v2"]["buyThreshold"] == 0.68
    assert result.config["signal"]["buySignalScore"] == 0.52
    assert result.config["sltp"]["slMultBase"] == 2.0
    assert result.contract.degraded is True
    assert set(result.contract.missing_sections) >= {"alphaFramework", "signal", "sltp", "L2_formula"}
    assert result.contract.source == "direct_kv_merged_required_defaults"


def test_worker_merged_config_is_preferred_and_raw_missing_sections_are_default_notes(monkeypatch):
    monkeypatch.setattr(
        loader,
        "get_raw_trading_config",
        lambda: {"ranking": {"topK": 4}},
    )
    monkeypatch.setattr(
        loader,
        "load_active_trading_config",
        lambda timeout=10.0: {
            "ranking": {"topK": 4, "enabled": True},
            "ensemble_v2": {"buyThreshold": 0.71},
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
        "alphaFramework": {"quality": {"minSamples": 30}},
        "signal": {"buySignalScore": 0.52},
        "sltp": {"slMultBase": 2.0},
        "L2_formula": {"confidence_risk_mult": 0.15},
    }
    monkeypatch.setattr(loader, "get_raw_trading_config", lambda: full)
    monkeypatch.setattr(loader, "load_active_trading_config", lambda timeout=10.0: full)

    result = loader.load_merged_trading_config_with_contract()

    assert result.contract.degraded is False
    assert result.contract.missing_sections == []
    assert result.config["ensemble_v2"]["buyThreshold"] == 0.70
