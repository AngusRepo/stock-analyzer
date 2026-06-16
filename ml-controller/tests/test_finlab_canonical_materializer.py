from __future__ import annotations

import sys
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import (
    build_d1_upsert_statements,
    build_emerging_broker_rows,
    build_listed_broker_flow_rows,
    build_taxonomy_rows,
    materialize_finlab_canonical_outputs,
    normalize_symbol,
)
from tools.finlab_v4_remote_backfill import default_canonical_window, parse_canonical_datasets


def _write(path: Path, df: pl.DataFrame) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    df.write_parquet(path)


def _root(name: str) -> Path:
    return Path("data") / "tmp" / "finlab_materializer_tests" / name


def test_normalize_symbol_handles_rotc_name_suffix() -> None:
    assert normalize_symbol("6682 Test Emerging") == "6682"
    assert normalize_symbol("2330") == "2330"


def test_remote_backfill_canonical_defaults_are_incremental() -> None:
    start, end = default_canonical_window(generated_at="2026-05-20T14:00:00+00:00", window_days=7)
    assert (start, end) == ("2026-05-13", "2026-05-20")
    datasets = parse_canonical_datasets("")
    assert "canonical_market_daily" in datasets
    assert "canonical_institutional_amount_daily" in datasets
    assert "canonical_broker_flow_daily" in datasets
    assert parse_canonical_datasets("canonical_chip_daily, finlab_taxonomy_tags") == [
        "canonical_chip_daily",
        "finlab_taxonomy_tags",
    ]


def test_emerging_broker_rows_materialize_canonical_chip_and_lineage() -> None:
    root = _root("broker_rows")
    _write(
        root / "raw" / "emerging_chip_diversity" / "rotc_broker_daily.parquet",
        pl.DataFrame(
            {
                "date": ["2026-05-15", "2026-05-15"],
                "stock_id": ["6682 Test Emerging", "7820 Test Emerging B"],
                "buy_shares": [12000.0, 5000.0],
                "sell_shares": [2000.0, 8000.0],
                "buy_sell_net": [10000.0, -3000.0],
                "dominant_net_shares": [9000.0, -2500.0],
                "gross_imbalance_shares": [14000.0, 6000.0],
                "broker_count": [9, 4],
            }
        ),
    )
    _write(
        root / "raw" / "emerging_price_diversity" / "close.parquet",
        pl.DataFrame({"date": ["2026-05-15"], "6682": [15.0], "7820": [42.0]}),
    )

    chip_rows, broker_rows = build_emerging_broker_rows(
        root,
        run_id="finlab-v4-test",
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-05-15",
        end_date="2026-05-15",
    )

    chip_6682 = next(row for row in chip_rows if row["stock_id"] == "6682")
    broker_6682 = next(row for row in broker_rows if row["stock_id"] == "6682")
    assert chip_6682["market_segment"] == "EMERGING"
    assert chip_6682["dealer_net"] == 9000.0
    assert chip_6682["source"] == "finlab.rotc_broker_transactions"
    assert broker_6682["estimated_amount"] == 135000.0
    assert broker_6682["dominant_net_shares"] == 9000.0
    assert broker_6682["gross_imbalance_shares"] == 14000.0
    assert broker_6682["broker_count"] == 9
    assert broker_6682["concentration"] > 0


def test_listed_broker_transactions_materialize_canonical_broker_flow() -> None:
    root = _root("listed_broker_rows")
    _write(
        root / "raw" / "broker_flow_diversity" / "broker_daily.parquet",
        pl.DataFrame(
            {
                "date": ["2026-06-15", "2026-06-15"],
                "stock_id": ["2330", "2317"],
                "buy_shares": [16000.0, 4000.0],
                "sell_shares": [7000.0, 9000.0],
                "buy_sell_net": [9000.0, -5000.0],
                "dominant_net_shares": [6000.0, -4200.0],
                "gross_imbalance_shares": [11000.0, 7600.0],
                "broker_count": [11, 5],
                "source": ["finlab.broker_transactions", "finlab.broker_transactions"],
                "market_segment": ["LISTED_OTC", "LISTED_OTC"],
            }
        ),
    )
    _write(
        root / "raw" / "daily_price" / "close.parquet",
        pl.DataFrame({"date": ["2026-06-15"], "2330": [100.0], "2317": [50.0]}),
    )

    rows = build_listed_broker_flow_rows(
        root,
        run_id="finlab-v4-test",
        generated_at="2026-06-16T00:00:00+00:00",
        start_date="2026-06-15",
        end_date="2026-06-15",
    )

    row_2330 = next(row for row in rows if row["stock_id"] == "2330")
    assert row_2330["market_segment"] == "LISTED_OTC"
    assert row_2330["source"] == "finlab.broker_transactions"
    assert row_2330["net_shares"] == 6000.0
    assert row_2330["estimated_amount"] == 600000.0
    assert row_2330["broker_count"] == 11
    assert row_2330["concentration"] > 0


def test_taxonomy_rows_build_four_layer_finlab_tags() -> None:
    root = _root("taxonomy_rows")
    _write(
        root / "raw" / "security_master" / "table.parquet",
        pl.DataFrame(
            {
                "symbol": ["2330"],
                "stock_id": ["2330"],
                "name": ["TSMC"],
                "category": ["Semiconductor"],
                "market": ["sii"],
            }
        ),
    )
    _write(
        root / "raw" / "taxonomy_expansion" / "table.parquet",
        pl.DataFrame(
            {
                "symbol": ["2330"],
                "stock_id": ["2330"],
                "name": ["TSMC"],
                "category": ["['AI', 'Semiconductor:Foundry', 'CoWoS']"],
                "key_date": ["2026-05-15"],
            }
        ),
    )

    rows = build_taxonomy_rows(root, generated_at="2026-05-18T00:00:00+00:00")
    tags = {(row["tag_type"], row["tag"]) for row in rows}
    assert ("industry", "Semiconductor") in tags
    assert ("industry_theme", "Semiconductor") in tags
    assert ("subindustry", "Foundry") in tags
    assert ("industry_theme", "AI") in tags
    assert ("industry_theme", "CoWoS") in tags


def test_materialize_outputs_report_nonzero_canonical_rows() -> None:
    root = _root("materialize_outputs")
    _write(root / "raw" / "daily_price" / "close.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [100.0]}))
    for field in ["open", "high", "low", "volume", "value"]:
        _write(root / "raw" / "daily_price" / f"{field}.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [1.0]}))
    _write(root / "raw" / "chip_diversity" / "foreign_net.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [1000.0]}))
    for field in ["trust_net", "dealer_self_net", "dealer_hedge_net", "margin_balance", "short_balance"]:
        _write(root / "raw" / "chip_diversity" / f"{field}.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [0.0]}))
    _write(root / "raw" / "revenue" / "revenue.parquet", pl.DataFrame({"date": ["2026-05-01"], "2330": [100.0]}))
    for field in ["mom", "yoy"]:
        _write(root / "raw" / "revenue" / f"{field}.parquet", pl.DataFrame({"date": ["2026-05-01"], "2330": [1.0]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-05-01",
        end_date="2026-05-15",
    )

    assert outputs.manifest["row_counts"]["canonical_market_daily"] == 1
    assert outputs.manifest["row_counts"]["canonical_chip_daily"] == 1
    assert outputs.manifest["row_counts"]["canonical_revenue_monthly"] == 1
    assert outputs.source_quality_metrics
    statements = build_d1_upsert_statements(outputs)
    assert statements
    assert any("INSERT INTO canonical_market_daily" in sql for sql, _ in statements)
    assert any("INSERT INTO finlab_materialization_manifest" in sql for sql, _ in statements)


def test_materialize_outputs_include_institutional_amount_summary() -> None:
    root = _root("institutional_amount")
    categories = ["上市外資及陸資(不含外資自營商)", "上櫃投信"]
    _write(
        root / "raw" / "institutional_amount_summary" / "buy_amount.parquet",
        pl.DataFrame({"date": ["2026-06-05"], categories[0]: [100.0], categories[1]: [30.0]}),
    )
    _write(
        root / "raw" / "institutional_amount_summary" / "sell_amount.parquet",
        pl.DataFrame({"date": ["2026-06-05"], categories[0]: [70.0], categories[1]: [50.0]}),
    )
    _write(
        root / "raw" / "institutional_amount_summary" / "net_amount.parquet",
        pl.DataFrame({"date": ["2026-06-05"], categories[0]: [30.0], categories[1]: [-20.0]}),
    )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-06T00:00:00+00:00",
        start_date="2026-06-05",
        end_date="2026-06-05",
        datasets=["canonical_institutional_amount_daily"],
    )

    assert outputs.manifest["row_counts"]["canonical_institutional_amount_daily"] == 2
    listed_foreign = next(row for row in outputs.canonical_institutional_amount_daily if row["market_segment"] == "LISTED")
    otc_trust = next(row for row in outputs.canonical_institutional_amount_daily if row["market_segment"] == "OTC")
    assert listed_foreign["investor"] == "foreign"
    assert listed_foreign["net_amount"] == 30.0
    assert otc_trust["investor"] == "trust"
    assert otc_trust["net_amount"] == -20.0
    statements = build_d1_upsert_statements(outputs)
    assert any("INSERT INTO canonical_institutional_amount_daily" in sql for sql, _ in statements)


def test_materialize_outputs_can_apply_revenue_dataset_only() -> None:
    root = _root("materialize_revenue_only")
    _write(root / "raw" / "revenue" / "revenue.parquet", pl.DataFrame({"date": ["2026-05-01"], "2330": [100.0]}))
    for field in ["mom", "yoy"]:
        _write(root / "raw" / "revenue" / f"{field}.parquet", pl.DataFrame({"date": ["2026-05-01"], "2330": [1.0]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-05-01",
        end_date="2026-05-31",
        datasets=["canonical_revenue_monthly"],
    )

    assert outputs.manifest["row_counts"] == {"canonical_revenue_monthly": 1}
    assert outputs.canonical_market_daily == []
    assert outputs.canonical_chip_daily == []
    assert outputs.canonical_revenue_monthly[0]["stock_id"] == "2330"
    assert outputs.source_quality_metrics[0]["dataset"] == "canonical_revenue_monthly"
