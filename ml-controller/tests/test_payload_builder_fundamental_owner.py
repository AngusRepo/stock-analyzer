from pathlib import Path


def test_payload_builder_does_not_fallback_to_legacy_financials() -> None:
    source = Path("services/payload_builder.py").read_text(encoding="utf-8")
    assert "FROM canonical_fundamental_features" in source
    assert "FROM financials" not in source
    assert "canonical_fundamental_features: latest point-in-time snapshot" in source


def test_payload_builder_uses_canonical_revenue_monthly() -> None:
    source = Path("services/payload_builder.py").read_text(encoding="utf-8")
    assert "FROM canonical_revenue_monthly" in source
    assert "FROM monthly_revenue" not in source
    assert "canonical_revenue_monthly: latest revenue_yoy/revenue_mom" in source
