import pytest
from services import research_data_access as data


def test_weekend_uses_latest_available_session(monkeypatch):
    monkeypatch.setattr(data, "latest_snapshot_business_end_date", lambda **kw: "2026-10-02")
    assert data.resolve_research_end_date(kind="backtest_dataset", as_of_date="2026-10-04") == "2026-10-02"


def test_explicit_window_is_not_silently_shortened(monkeypatch):
    monkeypatch.setattr(data, "latest_snapshot_business_end_date", lambda **kw: pytest.fail("not a default"))
    assert data.resolve_research_end_date(kind="backtest_dataset", as_of_date="2026-10-04", explicit_end_date="2026-10-03") == "2026-10-03"


@pytest.mark.parametrize("end", [None, "2026-10-05"])
def test_missing_or_future_snapshot_fails(monkeypatch, end):
    monkeypatch.setattr(data, "latest_snapshot_business_end_date", lambda **kw: end)
    with pytest.raises(data.ResearchSnapshotNotReadyError):
        data.resolve_research_end_date(kind="backtest_dataset", as_of_date="2026-10-04")


def test_explicit_future_fails():
    with pytest.raises(data.ResearchSnapshotNotReadyError):
        data.resolve_research_end_date(kind="backtest_dataset", as_of_date="2026-10-04", explicit_end_date="2026-10-05")
