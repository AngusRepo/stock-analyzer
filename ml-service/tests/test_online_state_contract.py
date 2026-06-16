from __future__ import annotations

import pytest

from app import arf_aggregator, linucb_bandit


def test_arf_update_state_is_artifact_required(monkeypatch):
    monkeypatch.setattr(arf_aggregator, "_load_arf_gcs", lambda: None)

    with pytest.raises(FileNotFoundError, match="ARF state missing in GCS"):
        arf_aggregator.load_arf()

    fresh = arf_aggregator.load_arf(allow_fresh=True)
    assert isinstance(fresh, arf_aggregator.ARFAggregator)
    assert fresh.n_trained == 0


def test_arf_save_requires_gcs_persistence(monkeypatch, tmp_path):
    monkeypatch.setattr(arf_aggregator, "_save_arf_gcs", lambda _arf: False)

    with pytest.raises(RuntimeError, match="ARF GCS save failed"):
        arf_aggregator.save_arf(arf_aggregator.ARFAggregator(), str(tmp_path))


def test_linucb_update_state_is_artifact_required(monkeypatch):
    monkeypatch.setattr(linucb_bandit, "_load_bandit_gcs", lambda: None)

    with pytest.raises(FileNotFoundError, match="LinUCB state missing in GCS"):
        linucb_bandit.load_bandit("/tmp/linucb_bandit")

    fresh = linucb_bandit.load_bandit("/tmp/linucb_bandit", allow_fresh=True)
    assert isinstance(fresh, linucb_bandit.LinUCBBandit)
    assert fresh.total_observations() == 0


def test_linucb_save_requires_gcs_persistence(monkeypatch, tmp_path):
    monkeypatch.setattr(linucb_bandit, "_save_bandit_gcs", lambda _bandit: False)

    with pytest.raises(RuntimeError, match="LinUCB GCS save failed"):
        linucb_bandit.save_bandit(linucb_bandit.LinUCBBandit(), str(tmp_path))
