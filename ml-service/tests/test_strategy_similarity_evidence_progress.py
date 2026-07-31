from app.strategy_similarity_evidence import build_strategy_similarity_evidence


def test_blocked_oof_evidence_preserves_raw_pair_progress(monkeypatch):
    from tests.test_strategy_similarity_evidence import _install_fake_kmedoids
    module = _install_fake_kmedoids(monkeypatch)
    evidence = module.build_strategy_similarity_evidence({
        "strategies": [
            {"strategy_id": "left", "symbols": ["2330"], "oof_returns": [
                {"signal_date": "2026-07-15", "residual_return": 0.01, "sample_count": 5},
                {"signal_date": "2026-07-23", "residual_return": 0.02, "sample_count": 5},
            ]},
            {"strategy_id": "right", "symbols": ["2317"], "oof_returns": [
                {"signal_date": "2026-07-15", "residual_return": 0.03, "sample_count": 5},
                {"signal_date": "2026-07-23", "residual_return": 0.01, "sample_count": 5},
            ]},
        ],
    })
    assert evidence["status"] == "blocked"
    assert evidence["eligible_oof_pair_count"] == 0
    assert evidence["paired_date_max"] == 2
    assert evidence["eligible_paired_date_max"] == 0
    assert evidence["paired_date_requirement"] == 5
    assert evidence["pair_count_with_any_overlap"] == 1
