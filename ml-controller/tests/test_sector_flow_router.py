import asyncio

from routers import sector_flow as sector_flow_router
from services import sector_flow_service


def test_rrg_backfill_uses_historical_reconstruction_for_past_dates(monkeypatch):
    calls = []

    def fake_pipeline(date, *, reconstruction_mode):
        calls.append((date, reconstruction_mode))
        return {"as_of_date": date, "reconstruction_mode": reconstruction_mode}

    monkeypatch.setattr(sector_flow_router, "_today_tw", lambda: "2026-07-31")
    monkeypatch.setattr(sector_flow_service, "run_sector_flow_pipeline", fake_pipeline)

    result = asyncio.run(sector_flow_router.backfill_rrg(
        sector_flow_router.RrgBackfillRequest(dates=["2026-07-29", "2026-07-31"]),
    ))

    assert result["backfilled"] == 2
    assert calls == [
        ("2026-07-29", "historical_reconstruction"),
        ("2026-07-31", "native"),
    ]
