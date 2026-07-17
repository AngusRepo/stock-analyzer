from pathlib import Path


def test_payload_builder_does_not_fallback_to_legacy_financials() -> None:
    source = Path("services/payload_builder.py").read_text(encoding="utf-8")
    assert "FROM canonical_fundamental_features" in source
    assert "FROM financials" not in source
    assert "canonical_fundamental_features: latest point-in-time value per field owner" in source
    assert "finlab.daily_valuation" in source
    assert "MAX(available_date)" not in source
    assert "canonical_by_stock" in source
    assert "f.available_date <= ?" in source
    assert "f.as_of_date <= ?" in source
    assert 'decision_date=state["run_date"]' in Path("graphs/daily_pipeline_v2.py").read_text(encoding="utf-8")


def test_payload_builder_uses_canonical_revenue_monthly() -> None:
    source = Path("services/payload_builder.py").read_text(encoding="utf-8")
    assert "FROM canonical_revenue_monthly" in source
    assert "FROM monthly_revenue" not in source
    assert "canonical_revenue_monthly: latest row known by the decision date" in source
    assert "r.revenue_month <= substr(?, 1, 7)" in source
    assert "r.as_of_date <= ?" in source


def test_snapshot_and_recommendation_fundamentals_enforce_bitemporal_cutoff() -> None:
    snapshot = Path("services/dataset_snapshot_exporter.py").read_text(encoding="utf-8")
    recommendation = Path("services/recommendation_service.py").read_text(encoding="utf-8")
    assert "WHERE available_date <= ?\n          AND as_of_date <= ?" in snapshot
    assert "[*chunk, decision_date, decision_date]" in recommendation
