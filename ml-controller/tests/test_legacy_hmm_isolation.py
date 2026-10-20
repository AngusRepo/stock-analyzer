"""R30: prohibit silently fabricated historical regimes and future fallback."""
import pytest
from services import walk_forward_retrain as wf


@pytest.mark.parametrize("batch", [False, True])
def test_retired_replay_never_loads_or_predicts(monkeypatch, batch):
    monkeypatch.setattr(wf, "_index_windows", lambda *a: pytest.fail("legacy model accessed"))
    with pytest.raises(RuntimeError, match="legacy_hmm_replay_disabled"):
        if batch:
            wf.predict_regime_batch(None, [])
        else:
            wf.predict_regime_at_date(None, "2026-09-30")


def test_cutoff_without_history_must_not_return_future_market_env():
    future = {"history": {"2026-10-02": {"risk_score": 99}}}
    with pytest.raises(ValueError, match="hmm_training_history_empty_before_cutoff"):
        wf._filter_market_env_by_end_date(future, "2026-10-01")


def test_cutoff_uses_only_prior_history_without_mutating_source():
    source = {"history": {"2026-09-30": {"risk_score": 12},
                          "2026-10-02": {"risk_score": 99}}}
    result = wf._filter_market_env_by_end_date(source, "2026-10-01")
    assert result == {"history": {"2026-09-30": {"risk_score": 12}}, "risk_score": 12}
    assert len(source["history"]) == 2
