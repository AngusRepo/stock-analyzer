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
    build_fundamental_feature_rows,
    build_taxonomy_rows,
    materialize_finlab_canonical_outputs,
    normalize_symbol,
)
from tools import finlab_v4_remote_backfill as remote_backfill
from tools.finlab_v4_remote_backfill import (
    canonical_apply_skipped_status,
    default_canonical_window,
    optional_fundamental_specs_from_env,
    parse_canonical_datasets,
)


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
    start, end = default_canonical_window(
        generated_at="2026-05-26T14:00:00+00:00",
        window_days=1,
        run_date="2026-05-25",
    )
    assert (start, end) == ("2026-05-24", "2026-05-25")
    datasets = parse_canonical_datasets("")
    assert "canonical_market_daily" in datasets
    assert "canonical_broker_flow_daily" in datasets
    assert "canonical_institutional_amount_daily" in datasets
    assert "canonical_fundamental_features" in datasets
    assert parse_canonical_datasets("canonical_chip_daily, finlab_taxonomy_tags") == [
        "canonical_chip_daily",
        "finlab_taxonomy_tags",
    ]


def test_remote_backfill_service_import_roots_support_repo_and_container_layout(monkeypatch) -> None:
    repo_root = Path("/repo")
    container_root = Path("/app")
    existing = {
        repo_root / "ml-controller" / "services",
        container_root / "services",
    }
    monkeypatch.setattr(Path, "exists", lambda self: self in existing)

    assert remote_backfill.service_import_roots(repo_root) == [repo_root / "ml-controller"]
    assert remote_backfill.service_import_roots(container_root) == [container_root]


def test_remote_backfill_marks_canonical_apply_skipped_when_write_d1_summary_only() -> None:
    skipped = canonical_apply_skipped_status(write_d1=True, apply_canonical_d1=False)

    assert skipped is not None
    assert skipped["status"] == "skipped"
    assert skipped["required_flag"] == "--apply-canonical-d1"
    assert "canonical row-level D1 tables stay stale" in skipped["impact"]
    assert canonical_apply_skipped_status(write_d1=True, apply_canonical_d1=True) is None
    assert canonical_apply_skipped_status(write_d1=False, apply_canonical_d1=False) is None


def test_remote_backfill_fundamental_factor_spec_is_explicit_env_mapping(monkeypatch) -> None:
    monkeypatch.setenv(
        "FINLAB_FUNDAMENTAL_FACTOR_KEYS_JSON",
        '{"roe":"fundamental_features:roe","pe":"fundamental_features:pe"}',
    )

    specs = optional_fundamental_specs_from_env()

    assert len(specs) == 1
    assert specs[0].lane == "fundamental_factor_diversity"
    assert specs[0].kind == "wide_fields"
    assert specs[0].keys == {
        "roe": "fundamental_features:roe",
        "pe": "fundamental_features:pe",
    }


def test_remote_backfill_cleanup_tolerates_d1_exec_without_meta(monkeypatch) -> None:
    monkeypatch.setattr(remote_backfill, "d1_exec", lambda *_args, **_kwargs: None)

    assert remote_backfill.cleanup_finlab_trading_restrictions() == 0


def test_remote_backfill_cleanup_reports_d1_changes(monkeypatch) -> None:
    monkeypatch.setattr(remote_backfill, "d1_exec", lambda *_args, **_kwargs: {"meta": {"changes": 7}})

    assert remote_backfill.cleanup_finlab_trading_restrictions() == 7


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


def test_fundamental_feature_rows_materialize_no_lookahead_contract() -> None:
    root = _root("fundamental_features")
    for field, value in {
        "roe": 18.0,
        "eps": 2.1,
        "pe": 12.0,
        "pb": 1.4,
        "dividend_yield": 3.0,
        "debt_ratio": 35.0,
        "current_ratio": 180.0,
        "operating_cash_flow": 100.0,
        "industry_quality_percentile": 0.9,
    }.items():
        _write(
            root / "raw" / "fundamental_factor_diversity" / f"{field}.parquet",
            pl.DataFrame({"date": ["2026-03-31"], "2330": [value]}),
        )

    rows = build_fundamental_feature_rows(
        root,
        run_id="finlab-v4-test",
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-03-01",
        end_date="2026-03-31",
    )

    assert len(rows) == 1
    row = rows[0]
    assert row["stock_id"] == "2330"
    assert row["period"] == "2026-03-31"
    assert row["available_date"] == "2026-05-30"
    assert row["roe"] == 18.0
    assert row["source"] == "finlab.fundamental_factor_diversity"


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
    assert "canonical_fundamental_features" in outputs.manifest["row_counts"]
    assert outputs.source_quality_metrics
    statements = build_d1_upsert_statements(outputs)
    assert statements
    assert any("INSERT INTO canonical_market_daily" in sql for sql, _ in statements)
    assert any("INSERT INTO finlab_materialization_manifest" in sql for sql, _ in statements)


def test_materialize_outputs_can_apply_fundamental_features_dataset_only() -> None:
    root = _root("materialize_fundamental_only")
    for field, value in {
        "roe": 20.0,
        "eps": 3.0,
        "pe": 15.0,
        "pb": 2.0,
    }.items():
        _write(
            root / "raw" / "fundamental_factor_diversity" / f"{field}.parquet",
            pl.DataFrame({"date": ["2026-03-31"], "2330": [value]}),
        )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-05-18T00:00:00+00:00",
        start_date="2026-03-01",
        end_date="2026-03-31",
        datasets=["canonical_fundamental_features"],
    )

    assert outputs.manifest["row_counts"] == {"canonical_fundamental_features": 1}
    assert outputs.canonical_market_daily == []
    assert outputs.canonical_fundamental_features[0]["available_date"] == "2026-05-30"
    statements = build_d1_upsert_statements(outputs)
    assert any("INSERT INTO canonical_fundamental_features" in sql for sql, _ in statements)


def test_materialize_institutional_amount_summary_uses_official_daily_amounts() -> None:
    root = _root("institutional_amount_summary")
    for field, values in {
        "buy_amount": {
            "上市外資及陸資(不含外資自營商)": 398_309_751_347.0,
            "上市投信": 32_552_166_835.0,
            "上市自營商(自行買賣)": 10_422_313_674.0,
            "上市自營商(避險)": 36_871_311_540.0,
            "上市合計": 478_155_543_396.0,
        },
        "sell_amount": {
            "上市外資及陸資(不含外資自營商)": 337_969_068_387.0,
            "上市投信": 27_171_867_723.0,
            "上市自營商(自行買賣)": 4_000_146_350.0,
            "上市自營商(避險)": 23_697_385_832.0,
            "上市合計": 392_838_468_292.0,
        },
        "net_amount": {
            "上市外資及陸資(不含外資自營商)": 60_340_682_960.0,
            "上市投信": 5_380_299_112.0,
            "上市自營商(自行買賣)": 6_422_167_324.0,
            "上市自營商(避險)": 13_173_925_708.0,
            "上市合計": 85_317_075_104.0,
        },
    }.items():
        _write(
            root / "raw" / "institutional_amount_summary" / f"{field}.parquet",
            pl.DataFrame({"date": ["2026-05-21"], **{name: [value] for name, value in values.items()}}),
        )

    outputs = materialize_finlab_canonical_outputs(
        root,
        generated_at="2026-05-22T00:00:00+00:00",
        start_date="2026-05-21",
        end_date="2026-05-21",
        datasets=["canonical_institutional_amount_daily"],
    )

    rows = outputs.canonical_institutional_amount_daily
    foreign = next(row for row in rows if row["market_segment"] == "LISTED" and row["investor"] == "foreign")
    total = next(row for row in rows if row["market_segment"] == "LISTED" and row["investor"] == "total")
    assert foreign["net_amount"] == 60_340_682_960.0
    assert total["net_amount"] == 85_317_075_104.0
    assert foreign["source"] == "finlab.institutional_investors_trading_all_market_summary"
    assert outputs.manifest["row_counts"]["canonical_institutional_amount_daily"] == 5
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
