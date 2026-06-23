from pathlib import Path


def test_legacy_topk_override_is_retired_in_daily_pipeline():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    loader = (Path(__file__).resolve().parents[1] / "services" / "trading_config_loader.py").read_text(encoding="utf-8")

    assert 'ev2_cfg.get("topKOverrideEnabled", True)' not in source
    assert "legacy_topk_override_retired" in source
    assert 'ev2["topk_forced"] = True' not in source
    assert 'ev2["signal"] = "BUY"' not in source
    assert '"topKOverrideEnabled": False' in loader
    assert '"allowLegacyTopKOverride": False' in loader
