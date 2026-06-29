from __future__ import annotations

import math
import sys
from pathlib import Path

import polars as pl

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "ml-controller"))

from services.finlab_canonical_materializer import (
    build_d1_upsert_statements,
    build_broker_rank_rows,
    build_emerging_broker_rows,
    build_listed_broker_flow_rows,
    build_market_summary_rows,
    build_taxonomy_rows,
    materialize_finlab_canonical_outputs,
    normalize_symbol,
)
from tools.finlab_v4_remote_backfill import default_canonical_window, parse_canonical_datasets, parse_lanes


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
    assert "canonical_market_index_daily" in datasets
    assert "canonical_futures_daily" in datasets
    assert "canonical_market_summary_daily" in datasets
    assert "canonical_regime_context_daily" in datasets
    assert "canonical_broker_flow_daily" in datasets
    assert "canonical_broker_rank_daily" in datasets
    assert "canonical_fundamental_features" in datasets
    assert parse_canonical_datasets("canonical_chip_daily, finlab_taxonomy_tags") == [
        "canonical_chip_daily",
        "finlab_taxonomy_tags",
    ]
    assert parse_canonical_datasets("canonical_broker_flow_daily") == [
        "canonical_broker_flow_daily",
        "canonical_broker_rank_daily",
    ]
    assert parse_lanes("daily_price, chip_diversity") == ["daily_price", "chip_diversity"]


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


def test_listed_broker_rank_rows_materialize_top_buy_sell() -> None:
    root = _root("listed_broker_rank_rows")
    _write(
        root / "raw" / "broker_flow_diversity" / "broker_rank_daily.parquet",
        pl.DataFrame(
            {
                "date": ["2026-06-15", "2026-06-15"],
                "stock_id": ["2330", "2330"],
                "rank_side": ["buy", "sell"],
                "rank_no": [1, 1],
                "broker_code": ["9200", "9800"],
                "broker_name": ["Broker Buy", "Broker Sell"],
                "buy_lots": [8000.0, 1000.0],
                "sell_lots": [2000.0, 7000.0],
                "net_lots": [6000.0, -6000.0],
                "source": ["finlab.broker_transactions", "finlab.broker_transactions"],
                "market_segment": ["LISTED_OTC", "LISTED_OTC"],
            }
        ),
    )

    rows = build_broker_rank_rows(
        root,
        run_id="finlab-v4-test",
        generated_at="2026-06-16T00:00:00+00:00",
        lane="broker_flow_diversity",
        filename="broker_rank_daily.parquet",
        market_segment="LISTED_OTC",
        source="finlab.broker_transactions",
        start_date="2026-06-15",
        end_date="2026-06-15",
    )

    buy = next(row for row in rows if row["rank_side"] == "buy")
    sell = next(row for row in rows if row["rank_side"] == "sell")
    assert buy["stock_id"] == "2330"
    assert buy["rank_no"] == 1
    assert buy["broker_code"] == "9200"
    assert buy["net_lots"] == 6000.0
    assert sell["broker_code"] == "9800"
    assert sell["net_lots"] == -6000.0


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


def test_d1_upsert_statements_sanitize_non_finite_values() -> None:
    root = _root("non_finite_d1_params")
    _write(root / "raw" / "daily_price" / "close.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [math.nan]}))
    for field in ["open", "high", "low", "volume", "value"]:
        _write(root / "raw" / "daily_price" / f"{field}.parquet", pl.DataFrame({"date": ["2026-05-15"], "2330": [1.0]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-05-15",
        end_date="2026-05-15",
        datasets=["canonical_market_daily"],
    )

    market_statement = next(
        params
        for sql, params in build_d1_upsert_statements(outputs)
        if "INSERT INTO canonical_market_daily" in sql
    )
    assert market_statement[6] is None


def test_materialize_outputs_can_exclude_emerging_rows_from_daily_primary() -> None:
    root = _root("exclude_emerging")
    for lane in ["daily_price", "emerging_price_diversity"]:
        _write(root / "raw" / lane / "close.parquet", pl.DataFrame({"date": ["2026-06-15"], "2330" if lane == "daily_price" else "6682": [100.0]}))
        for field in ["open", "high", "low", "volume", "value"]:
            _write(root / "raw" / lane / f"{field}.parquet", pl.DataFrame({"date": ["2026-06-15"], "2330" if lane == "daily_price" else "6682": [1.0]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-16T00:00:00+00:00",
        start_date="2026-06-15",
        end_date="2026-06-15",
        datasets=["canonical_market_daily"],
        include_emerging=False,
    )

    assert outputs.manifest["filters"]["include_emerging"] is False
    assert outputs.manifest["row_counts"]["canonical_market_daily"] == 1
    assert {row["market_segment"] for row in outputs.canonical_market_daily} == {"LISTED_OTC"}


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


def test_materialize_outputs_include_regime_context_market_index_and_futures() -> None:
    root = _root("regime_context")
    _write(
        root / "raw" / "regime_context" / "tw_stock_market_ind.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "加權指數": [22500.0], "櫃買指數": [280.5]}),
    )
    _write(
        root / "raw" / "regime_context" / "futures_contract_month.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "TX": ["202607"]}),
    )
    _write(
        root / "raw" / "regime_context" / "futures_close.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "TX": [22480.0]}),
    )
    _write(
        root / "raw" / "regime_context" / "business_signal_score.parquet",
        pl.DataFrame({"date": ["2026-05-01"], "景氣對策信號(分)": [39.0]}),
    )
    _write(
        root / "raw" / "regime_context" / "tw_option_put_call_ratio.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "pcr": [0.9]}),
    )
    _write(
        root / "raw" / "regime_context" / "tw_taifex_futures_large_trader.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "net_position": [2315.0]}),
    )
    _write(
        root / "raw" / "global_context" / "world_close.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "USDTWD": [31.825]}),
    )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-05-01",
        end_date="2026-06-27",
        datasets=[
            "canonical_market_index_daily",
            "canonical_futures_daily",
            "canonical_regime_context_daily",
        ],
    )

    assert outputs.manifest["row_counts"]["canonical_market_index_daily"] == 2
    assert outputs.manifest["row_counts"]["canonical_futures_daily"] == 1
    assert outputs.manifest["row_counts"]["canonical_regime_context_daily"] == 4
    assert {row["symbol"] for row in outputs.canonical_market_index_daily} == {"TWII", "TWOII"}
    assert outputs.canonical_futures_daily[0]["symbol"] == "TXF"
    context_fields = {(row["dataset"], row["field"]) for row in outputs.canonical_regime_context_daily}
    assert ("tw_business_indicators", "business_signal_score") in context_fields
    assert ("tw_option_put_call_ratio", "pcr") in context_fields
    assert ("tw_taifex_futures_large_trader", "net_position") in context_fields
    assert ("world_index", "world_close") in context_fields
    statements = build_d1_upsert_statements(outputs)
    assert any("INSERT INTO canonical_market_index_daily" in sql for sql, _ in statements)
    assert any("INSERT INTO canonical_futures_daily" in sql for sql, _ in statements)
    assert any("INSERT INTO canonical_regime_context_daily" in sql for sql, _ in statements)


def test_market_index_single_score_column_defaults_to_twii_symbol() -> None:
    root = _root("regime_context_market_index_score_alias")
    _write(
        root / "raw" / "regime_context" / "tw_stock_market_ind.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "score": [44571.76]}),
    )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-06-20",
        end_date="2026-06-27",
        datasets=["canonical_market_index_daily"],
    )

    assert outputs.manifest["row_counts"]["canonical_market_index_daily"] == 1
    assert outputs.canonical_market_index_daily[0]["symbol"] == "TWII"
    assert outputs.canonical_market_index_daily[0]["close"] == 44571.76
    statements = build_d1_upsert_statements(outputs)
    assert any(params[0] == "TWII" for sql, params in statements if "INSERT INTO canonical_market_index_daily" in sql)


def test_regime_context_keeps_monthly_business_signal_outside_daily_window() -> None:
    root = _root("regime_context_monthly_business_signal")
    _write(
        root / "raw" / "regime_context" / "business_signal_score.parquet",
        pl.DataFrame({"date": ["2026-05-01"], "景氣對策信號(分)": [39.0]}),
    )
    _write(
        root / "raw" / "regime_context" / "tw_option_put_call_ratio.parquet",
        pl.DataFrame({"date": ["2026-06-26"], "pcr": [0.9]}),
    )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-06-20",
        end_date="2026-06-27",
        datasets=["canonical_regime_context_daily"],
    )

    fields = {
        (row["dataset"], row["field"], row["date"], row["value"])
        for row in outputs.canonical_regime_context_daily
    }
    assert ("tw_business_indicators", "business_signal_score", "2026-05-01", 39.0) in fields
    assert ("tw_option_put_call_ratio", "pcr", "2026-06-26", 0.9) in fields


def test_materialize_outputs_include_official_tpex_index_artifact() -> None:
    root = _root("official_tpex_index")
    _write(
        root / "raw" / "regime_context" / "official_tpex_index.parquet",
        pl.DataFrame(
            {
                "date": ["2026-06-26"],
                "symbol": ["TWOII"],
                "name": ["櫃買指數"],
                "close": [415.26],
                "change": [-24.58],
            }
        ),
    )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-06-26",
        end_date="2026-06-26",
        datasets=["canonical_market_index_daily"],
    )

    assert outputs.manifest["row_counts"]["canonical_market_index_daily"] == 1
    assert outputs.canonical_market_index_daily[0]["symbol"] == "TWOII"
    assert outputs.canonical_market_index_daily[0]["source"] == "tpex.openapi.tpex_index"


def test_market_summary_rows_materialize_market_level_margin_amounts() -> None:
    root = _root("market_summary")
    _write(
        root / "raw" / "market_summary" / "twse_margin_trading_summary.parquet",
        pl.DataFrame(
            {
                "date": ["2026-06-26", "2026-06-26", "2026-06-26"],
                "market_segment": ["LISTED", "LISTED", "LISTED"],
                "item": ["融資(交易單位)", "融券(交易單位)", "融資金額(仟元)"],
                "買進": [209790.0, 10000.0, 15_000_000.0],
                "賣出": [160478.0, 9000.0, 14_000_000.0],
                "現金(券)償還": [17028.0, 1000.0, 500_000.0],
                "今日餘額": [8_826_342.0, 203_932.0, 590_925_882.0],
            }
        ),
    )

    rows = build_market_summary_rows(
        root,
        run_id="finlab-v4-test",
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-06-26",
        end_date="2026-06-26",
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["market_segment"] == "LISTED"
    assert row["margin_balance_units"] == 8_826_342.0
    assert row["margin_balance_value"] == 590_925_882_000.0
    assert row["short_balance_units"] == 203_932.0

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-06-26",
        end_date="2026-06-26",
        datasets=["canonical_market_summary_daily"],
    )
    assert outputs.manifest["row_counts"] == {"canonical_market_summary_daily": 1}
    statements = build_d1_upsert_statements(outputs)
    assert any("INSERT INTO canonical_market_summary_daily" in sql for sql, _ in statements)


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


def test_materialize_outputs_include_finlab_fundamental_capital_fields() -> None:
    root = _root("fundamental_features")
    lane = root / "raw" / "fundamental_factor_diversity"
    fields = {
        "revenue_growth_yoy": 12.5,
        "gross_margin": 53.2,
        "operating_margin": 42.1,
        "roe": 25.3,
        "eps": 9.87,
        "debt_ratio": 38.4,
        "current_ratio": 210.0,
        "operating_cash_flow": 1_000_000.0,
        "roa": 13.5,
        "free_cash_flow": 800_000.0,
        "capital_amount": 259_303_800.0,
        "common_stock_capital": 259_303_800.0,
        "preferred_stock_capital": 0.0,
        "total_assets": 4_000_000_000.0,
        "total_liabilities": 1_000_000_000.0,
        "equity_parent": 3_000_000_000.0,
    }
    for field, value in fields.items():
        _write(lane / f"{field}.parquet", pl.DataFrame({"date": ["2026-03-31"], "2330": [value]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-27T00:00:00+00:00",
        start_date="2026-03-01",
        end_date="2026-03-31",
        datasets=["canonical_fundamental_features"],
    )

    assert outputs.manifest["row_counts"] == {"canonical_fundamental_features": 1}
    row = outputs.canonical_fundamental_features[0]
    assert row["stock_id"] == "2330"
    assert row["gross_margin"] == 53.2
    assert row["capital_amount"] == 259_303_800_000.0
    assert row["source"] == "finlab.fundamental_factor_diversity"
    statements = build_d1_upsert_statements(outputs)
    assert any("INSERT INTO canonical_fundamental_features" in sql for sql, _ in statements)


def test_fundamental_materialization_drops_all_null_sparse_dates() -> None:
    root = _root("fundamental_sparse_null_dates")
    lane = root / "raw" / "fundamental_factor_diversity"
    _write(lane / "gross_margin.parquet", pl.DataFrame({"date": ["2026-01-01", "2026-06-02"], "2330": [66.2, None]}))
    _write(lane / "eps.parquet", pl.DataFrame({"date": ["2026-01-01", "2026-06-02"], "2330": [22.0, None]}))
    _write(lane / "capital_amount.parquet", pl.DataFrame({"date": ["2026-01-01", "2026-06-02"], "2330": [259_303_800.0, None]}))

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-06-29T00:00:00+00:00",
        start_date="2026-01-01",
        end_date="2026-06-02",
        datasets=["canonical_fundamental_features"],
    )

    assert outputs.manifest["row_counts"] == {"canonical_fundamental_features": 1}
    assert outputs.canonical_fundamental_features[0]["available_date"] == "2026-01-01"
    assert outputs.canonical_fundamental_features[0]["capital_amount"] == 259_303_800_000.0
