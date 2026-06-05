from pathlib import Path


def test_legacy_topk_override_requires_explicit_rollback_flag():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    loader = (Path(__file__).resolve().parents[1] / "services" / "trading_config_loader.py").read_text(encoding="utf-8")

    assert 'ev2_cfg.get("topKOverrideEnabled", True)' not in source
    assert 'ev2_cfg.get("allowLegacyTopKOverride", False)' in source
    assert 'and ev2_cfg.get("topKOverrideEnabled", False)' in source
    assert '"topKOverrideEnabled": False' in loader
    assert '"allowLegacyTopKOverride": False' in loader
