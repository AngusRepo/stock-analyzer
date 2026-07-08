from pathlib import Path


def test_daily_pipeline_forwards_allocator_ev_fusion_artifact_to_alpha_policy():
    source = Path("ml-controller/graphs/daily_pipeline_v2.py").read_text(encoding="utf-8")
    assert "allocator_ev_fusion_policy = (" in source
    assert '(trading_cfg.get("ensemble_v2", {}) or {}).get("allocatorEvFusion")' in source
    assert 'alpha_policy.setdefault("allocatorEvFusion", allocator_ev_fusion_policy)' in source
    assert 'alpha_policy.setdefault("allocator_ev_fusion", allocator_ev_fusion_policy)' in source
