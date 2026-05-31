from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import (  # noqa: E402
    FinLabCanonicalOutputs,
    build_d1_upsert_statements,
)


def _outputs() -> FinLabCanonicalOutputs:
    return FinLabCanonicalOutputs(
        run_id="finlab-v4-test",
        generated_at="2026-05-27T10:00:00+00:00",
        artifact_root="/tmp/finlab-v4-test",
        canonical_market_daily=[
            {
                "stock_id": "2330",
                "date": "2026-05-27",
                "market_segment": "LISTED_OTC",
                "open": 100.0,
                "high": 105.0,
                "low": 99.0,
                "close": 104.0,
                "volume": 2000.0,
                "value": 208000.0,
                "source": "finlab.price",
                "lineage_json": "{}",
                "as_of_date": "2026-05-27",
            }
        ],
        canonical_chip_daily=[],
        canonical_institutional_amount_daily=[],
        canonical_revenue_monthly=[],
        canonical_fundamental_features=[],
        canonical_broker_flow_daily=[],
        finlab_taxonomy_tags=[],
        data_source_inventory=[],
        source_quality_metrics=[],
        manifest={"row_counts": {"canonical_market_daily": 1}, "checksum": "sha256:test"},
    )


def test_finlab_canonical_market_daily_bridges_into_stock_prices_hot_path() -> None:
    statements = build_d1_upsert_statements(_outputs())
    bridge = [item for item in statements if "INSERT INTO stock_prices" in item[0]]

    assert len(bridge) == 1
    sql, params = bridge[0]
    assert "FROM stocks WHERE symbol = ?" in sql
    assert "ON CONFLICT(stock_id, date) DO UPDATE SET" in sql
    assert params == ["2026-05-27", 100.0, 105.0, 99.0, 104.0, 104.0, 2000, 104.0, "2330"]


def test_finlab_canonical_market_daily_does_not_bridge_missing_close() -> None:
    outputs = _outputs()
    outputs.canonical_market_daily.append({
        "stock_id": "5906",
        "date": "2026-05-27",
        "market_segment": "LISTED_OTC",
        "open": None,
        "high": None,
        "low": None,
        "close": None,
        "volume": 477.0,
        "value": 20248.0,
        "source": "finlab.price",
        "lineage_json": "{}",
        "as_of_date": "2026-05-27",
    })

    statements = build_d1_upsert_statements(outputs)
    bridge = [item for item in statements if "INSERT INTO stock_prices" in item[0]]

    assert len(bridge) == 1
    assert bridge[0][1][-1] == "2330"
