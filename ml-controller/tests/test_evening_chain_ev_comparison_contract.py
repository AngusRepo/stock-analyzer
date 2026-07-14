from pathlib import Path


SOURCE = Path("ml-controller/scripts/compare_evening_chain_ev_versions.py").read_text(
    encoding="utf-8"
)


def test_historical_variant_source_uses_requested_run_date() -> None:
    assert "persisted_2026-07-09_daily_recommendations" not in SOURCE
    assert 'f"persisted_{run_date}_daily_recommendations"' in SOURCE
    assert "_historical_actual_variant(rows, run_date=args.run_date)" in SOURCE
