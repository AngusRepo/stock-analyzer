from pathlib import Path


def test_legacy_topk_override_is_retired_in_daily_pipeline():
    source = (Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py").read_text(encoding="utf-8")
    loader = (Path(__file__).resolve().parents[1] / "services" / "trading_config_loader.py").read_text(encoding="utf-8")

    worker_config = (Path(__file__).resolve().parents[2] / "worker" / "src" / "lib" / "tradingConfig.ts").read_text(encoding="utf-8")
    joined = "\n".join((source, loader, worker_config))
    for forbidden in (
        "topKOverrideEnabled", "allowLegacyTopKOverride", "topKCount",
        "topKConfidenceOverride", "topk_forced",
    ):
        assert forbidden not in joined
    assert 'ev2["signal"] = "BUY"' not in source
