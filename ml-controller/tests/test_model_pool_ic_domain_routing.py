from __future__ import annotations

from pathlib import Path


def test_weekly_ic_reads_canonical_learning_d1() -> None:
    source = (
        Path(__file__).resolve().parent.parent / "routers" / "model_pool.py"
    ).read_text(encoding="utf-8")

    assert "LEARNING_D1_CLIENT = client_for_domain(D1DataDomain.LEARNING)" in source
    weekly_ic = source[source.index("async def compute_weekly_ic("):]
    assert weekly_ic.count("rows = LEARNING_D1_CLIENT.query(") == 2
    assert "rows = d1_query(" not in weekly_ic
    assert "FROM predictions" in weekly_ic


def test_training_price_queries_use_core_market_read_model_after_cutover() -> None:
    source = (Path(__file__).resolve().parent.parent / "services" / "domain_stock_read_models.py").read_text(encoding="utf-8")
    assert "load_market_price_rows_with_identity" in source
    assert "CORE_D1_CLIENT = client_proxy_for_domain(D1DataDomain.CORE)" in source
    assert "MARKET_D1_CLIENT = client_proxy_for_domain(D1DataDomain.MARKET)" in source
    assert "rows = MARKET_D1_CLIENT.query(" in source
    assert "identities = load_core_stock_identities(tradable_only=True)" in source
    assert "JOIN stock_prices" not in source