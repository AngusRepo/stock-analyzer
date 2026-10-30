from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np
import pandas as pd
import pytest


ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "tools" / "finlab_v4_remote_backfill.py"


def _load_tool_module():
    spec = importlib.util.spec_from_file_location("finlab_v4_remote_backfill_tool", TOOL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_adjusted_vintage_keeps_history_separate_from_daily_canonical(monkeypatch, tmp_path):
    import hashlib
    tool = _load_tool_module()
    monkeypatch.setattr(tool, "start_date_for_years", lambda _years: "2026-09-01")
    dates = pd.to_datetime(["2026-09-24", "2026-09-29", "2026-09-30"])
    frames = {field: tool.normalize_wide_index(pd.DataFrame({"3004": [16.619, 16.690, 99.0]}, index=dates))
              for field in ("adj_close", "adj_open")}
    canonical = tmp_path / "raw/daily_price/adj_close.parquet"
    tool.write_parquet(canonical, frames["adj_close"].loc[[dates[1]]])
    original = canonical.read_bytes()
    tool.write_adjusted_price_vintage(frames, run_dir=tmp_path, years=3, end_date="2026-09-29")
    root = tmp_path / "raw/daily_price_full_vintage"
    receipt = json.loads((root / "manifest.json").read_text())
    assert canonical.read_bytes() == original
    assert receipt["end_date"] == "2026-09-29"
    for field in frames:
        path = root / f"{field}.parquet"
        assert hashlib.sha256(path.read_bytes()).hexdigest() == receipt["checksums"][field]
        assert list(pd.read_parquet(path).index.strftime("%Y-%m-%d")) == ["2026-09-24", "2026-09-29"]


def test_adjusted_vintage_missing_pair_never_seals_receipt(tmp_path):
    tool = _load_tool_module()
    tool.write_adjusted_price_vintage({"adj_close": pd.DataFrame()}, run_dir=tmp_path, years=3, end_date="2026-09-29")
    assert not (tmp_path / "raw/daily_price_full_vintage/manifest.json").exists()


def test_cleanup_finlab_trading_restrictions_tolerates_empty_d1_exec(monkeypatch):
    tool = _load_tool_module()

    monkeypatch.setattr(tool, "d1_exec", lambda _sql, _params=None: None)

    assert tool.cleanup_finlab_trading_restrictions(retention_days=31) == 0


def test_cleanup_finlab_trading_restrictions_reads_d1_changes(monkeypatch):
    tool = _load_tool_module()

    monkeypatch.setattr(tool, "TRADING_RESTRICTION_CLEANUP_ENABLED", True)
    monkeypatch.setattr(tool, "d1_exec", lambda _sql, _params=None, **_kwargs: {"meta": {"changes": 7}})

    assert tool.cleanup_finlab_trading_restrictions(retention_days=31) == 7


def test_finlab_esb_attention_disposal_writes_canonical_restrictions(monkeypatch, tmp_path):
    tool = _load_tool_module()
    raw_dir = tmp_path / "raw" / "trading_restrictions"
    raw_dir.mkdir(parents=True)

    pd.DataFrame(
        {"2330": [True], "2317": [False]},
        index=pd.to_datetime(["2026-06-30"]),
    ).to_parquet(raw_dir / "esb_attention_flag.parquet")
    pd.DataFrame(
        {"2330": ["注意交易資訊"]},
        index=pd.to_datetime(["2026-06-30"]),
    ).to_parquet(raw_dir / "esb_attention_info.parquet")
    pd.DataFrame(
        {"6586": [True]},
        index=pd.to_datetime(["2026-06-25"]),
    ).to_parquet(raw_dir / "esb_disposition_flag.parquet")
    pd.DataFrame(
        {"6586": ["處置原因"]},
        index=pd.to_datetime(["2026-06-25"]),
    ).to_parquet(raw_dir / "esb_disposition_reason.parquet")
    pd.DataFrame(
        {"6586": ["2026-06-26"]},
        index=pd.to_datetime(["2026-06-25"]),
    ).to_parquet(raw_dir / "esb_disposition_start.parquet")
    pd.DataFrame(
        {"6586": ["2026-07-02"]},
        index=pd.to_datetime(["2026-06-25"]),
    ).to_parquet(raw_dir / "esb_disposition_end.parquet")

    manifest = {
        "run_id": "finlab-esb-test",
        "generated_at": "2026-07-01T00:00:00+00:00",
        "datasets": [
            {
                "lane": "trading_restrictions",
                "artifacts": [{"path": str(path)} for path in sorted(raw_dir.glob("*.parquet"))],
            }
        ],
    }
    captured = {}

    def fake_batch_execute(statements, **_kwargs):
        captured["statements"] = statements
        return {"success_count": len(statements)}

    monkeypatch.setattr(tool, "d1_batch_execute", fake_batch_execute)
    d1_calls: list[tuple[str, list]] = []
    monkeypatch.setattr(tool, "d1_exec", lambda sql, params=None, **_kwargs: d1_calls.append((sql, list(params or []))) or {"success": True})

    assert tool.insert_finlab_trading_restrictions(manifest, lookback_days=31, max_rows=20) == 2
    params = [item[1] for item in captured["statements"]]
    assert ["2330", "attention", "2026-06-30", "2026-07-31", "2026-06-30"] == params[0][:5]
    assert ["6586", "disposition", "2026-06-26", "2026-07-02", "2026-06-25"] == params[1][:5]
    source_quality = next(params for sql, params in d1_calls if "INSERT INTO source_quality_metrics" in sql)
    assert source_quality[1] == "trading_restrictions"
    assert source_quality[2] == "2026-07-01"
    assert source_quality[3] == "ok"


def test_remote_backfill_tool_bootstraps_cloud_run_app_root():
    source = TOOL_PATH.read_text(encoding="utf-8")

    assert "for candidate in (ROOT, ROOT / \"ml-controller\")" in source


def test_remote_backfill_tool_honors_requested_lanes_before_finlab_fetch():
    tool = _load_tool_module()
    source = TOOL_PATH.read_text(encoding="utf-8")

    assert tool.parse_lanes("daily_price, chip_diversity, market_summary") == ["daily_price", "chip_diversity", "market_summary"]
    assert 'parser.add_argument("--lanes"' in source
    assert "spec.lane in requested_lanes" in source
    assert "unknown FinLab lanes" in source
    assert 'lane="market_summary"' in source


def test_remote_backfill_tool_supports_daily_source_window_contract():
    tool = _load_tool_module()
    source = TOOL_PATH.read_text(encoding="utf-8")

    frame = pd.DataFrame(
        {"close": [10, 11, 12]},
        index=pd.to_datetime(["2026-06-29", "2026-06-30", "2026-07-01"]),
    )

    assert 'parser.add_argument("--source-start-date"' in source
    assert 'parser.add_argument("--source-end-date"' in source
    assert 'parser.add_argument("--require-official-market-summary"' in source
    assert "source_start_date or start_date_for_years(years)" in source
    assert "validate_official_market_summary_frames(frames, target_date=source_end_date)" in source
    assert "controller_d1_batch chunk=" in source
    assert list(tool.filter_date_range(frame, start_date="2026-07-01", end_date="2026-07-01")["close"]) == [12]


def test_finlab_fundamental_fields_require_deadline_alignment():
    tool = _load_tool_module()

    class DeadlineFrame(pd.DataFrame):
        _metadata = ["deadline_called"]

        @property
        def _constructor(self):
            return DeadlineFrame

        def deadline(self):
            self.deadline_called = True
            out = self.copy()
            out.index = pd.to_datetime(["2026-03-31"])
            return out

    raw = DeadlineFrame(
        {"2330": [66.2]},
        index=["2025-Q4"],
    )
    aligned = tool.normalize_finlab_wide_field(
        raw,
        api_key_name="fundamental_features:gross_margin",
        date_owners=(pd.DataFrame({"2330": pd.to_datetime(["2026-03-30"])}, index=["2025-Q4"]),
                     pd.DataFrame({"2330": pd.to_datetime(["2026-03-31"])}, index=["2025-Q4"])),
        sessions=pd.to_datetime(["2026-03-30", "2026-03-31"]),
    )

    assert not getattr(raw, "deadline_called", False)
    assert list(aligned.index) == [pd.Timestamp("2026-03-31")]
    assert aligned.index.name == "date"


def test_fundamental_canonical_apply_caps_multi_row_requests_at_ten_statements():
    tool = _load_tool_module()

    assert tool.canonical_dataset_chunk_size("canonical_fundamental_features", 500) == 10


def test_controller_d1_batch_preserves_zero_success_and_fails_fast(monkeypatch):
    tool = _load_tool_module()

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({
                "ok": True,
                "total": 1,
                "success_count": 0,
                "error_count": 1,
                "first_error": "too many SQL variables",
            }).encode("utf-8")

    monkeypatch.setattr(tool, "controller_d1_batch_url", lambda: "https://controller.example/d1/batch")
    monkeypatch.setattr(tool, "controller_proxy_token", lambda: "token")
    monkeypatch.setattr(tool.urllib.request, "urlopen", lambda *_args, **_kwargs: Response())

    with pytest.raises(RuntimeError, match="success_count=0.*too many SQL variables"):
        tool.controller_d1_batch_execute([("INSERT INTO sample VALUES (?)", [1])])


def test_controller_d1_batch_forwards_ops_domain(monkeypatch):
    tool = _load_tool_module()
    captured: dict = {}

    class Response:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return json.dumps({
                "ok": True,
                "total": 1,
                "success_count": 1,
                "error_count": 0,
            }).encode("utf-8")

    def fake_urlopen(request, **_kwargs):
        captured.update(json.loads(request.data.decode("utf-8")))
        return Response()

    monkeypatch.setattr(tool, "controller_d1_batch_url", lambda: "https://controller.example/d1/batch")
    monkeypatch.setattr(tool, "controller_proxy_token", lambda: "token")
    monkeypatch.setattr(tool.urllib.request, "urlopen", fake_urlopen)

    result = tool.controller_d1_batch_execute(
        [("INSERT INTO source_key_report VALUES (?)", [1])],
        domain="ops",
    )

    assert result["success_count"] == 1
    assert captured["domain"] == "ops"


def test_finlab_canonical_statement_partition_routes_domain_owners():
    tool = _load_tool_module()
    statements = [
        ("INSERT INTO canonical_market_daily VALUES (?)", [1]),
        ("INSERT INTO data_source_inventory VALUES (?)", [2]),
        ("INSERT OR REPLACE INTO finlab_materialization_manifest VALUES (?)", [3]),
        ("DELETE FROM finlab_taxonomy_tags WHERE symbol=?", [4]),
    ]

    legacy, ops, market = tool.partition_finlab_canonical_statements(statements, market_active=True)

    assert legacy == []
    assert [params for _sql, params in ops] == [[2], [3]]
    assert [params for _sql, params in market] == [[1], [4]]


def test_finlab_fundamental_fields_fail_closed_without_deadline_owner():
    import pytest

    tool = _load_tool_module()
    raw = pd.DataFrame({"2330": [66.2]}, index=pd.to_datetime(["2026-01-01"]))

    with pytest.raises(ValueError, match="finlab_deadline_alignment_unavailable"):
        tool.normalize_finlab_wide_field(
            raw,
            api_key_name="financial_statement:revenue",
        )


def test_finlab_daily_valuation_fields_keep_source_observation_dates():
    tool = _load_tool_module()
    raw = pd.DataFrame({"2330": [18.5]}, index=pd.to_datetime(["2026-07-16"]))

    aligned = tool.normalize_finlab_wide_field(
        raw,
        api_key_name="price_earning_ratio:pe",
    )

    assert list(aligned.index) == [pd.Timestamp("2026-07-16")]


def test_key_scoped_repair_validates_only_requested_required_fields():
    tool = _load_tool_module()
    gross = pd.DataFrame({"2330": [66.2]}, index=pd.to_datetime(["2026-06-01"]))

    assert tool.required_wide_field_errors(
        "fundamental_factor_diversity",
        {"gross_margin": gross},
        requested_fields={"gross_margin"},
    ) == []
    assert tool.required_wide_field_errors(
        "fundamental_factor_diversity",
        {"gross_margin": gross},
    ) == ["pb=missing", "pe=missing"]


def test_source_quality_zero_finlab_rows_is_empty_not_ok(monkeypatch):
    tool = _load_tool_module()
    calls: list[tuple[str, list]] = []

    def fake_d1_exec(sql, params=None, **_kwargs):
        calls.append((sql, list(params or [])))
        return {"success": True}

    monkeypatch.setattr(tool, "d1_exec", fake_d1_exec)
    manifest = {
        "run_id": "finlab-zero-row-test",
        "generated_at": "2026-07-02T10:30:00+00:00",
        "source_end_date": "2026-07-01",
        "lookback_years": 3,
        "checksum": "checksum",
        "mode": "daily_price_primary",
        "artifact_root": "gs://bucket/run",
        "summary": {
            "dataset_count": 1,
            "finlab_rows": 0,
            "gap_fill_rows": 0,
            "value_conflicts": 0,
        },
        "diff_reports": [{
            "dataset_lane": "chip_diversity",
            "source": "finlab",
            "generated_at": "2026-07-02T10:30:00+00:00",
            "summary": {
                "finlab_rows": 0,
                "stockvision_rows": 0,
                "matched": 0,
                "missing_in_stockvision": 0,
                "missing_in_finlab": 0,
                "value_conflicts": 0,
                "schema_extra_fields": [],
            },
        }],
    }

    tool.insert_d1_summary(manifest)

    source_quality = next(params for sql, params in calls if "INSERT INTO source_quality_metrics" in sql)
    assert source_quality[1] == "chip_diversity"
    assert source_quality[2] == "2026-07-01"
    assert source_quality[3] == "empty"
    assert source_quality[4] == 1.0


def test_source_quality_aggregates_duplicate_lane_reports_without_empty_overwrite(monkeypatch):
    tool = _load_tool_module()
    calls: list[tuple[str, list]] = []

    def fake_d1_exec(sql, params=None, **_kwargs):
        calls.append((sql, list(params or [])))
        return {"success": True}

    monkeypatch.setattr(tool, "d1_exec", fake_d1_exec)
    manifest = {
        "run_id": "finlab-duplicate-lane-test",
        "generated_at": "2026-07-05T10:30:00+00:00",
        "source_end_date": "2026-07-03",
        "lookback_years": 3,
        "checksum": "checksum",
        "mode": "daily_price_primary",
        "artifact_root": "gs://bucket/run",
        "summary": {
            "dataset_count": 2,
            "finlab_rows": 95,
            "gap_fill_rows": 0,
            "value_conflicts": 0,
        },
        "diff_reports": [
            {
                "dataset_lane": "trading_restrictions",
                "source": "finlab",
                "generated_at": "2026-07-05T10:30:00+00:00",
                "summary": {
                    "finlab_rows": 95,
                    "stockvision_rows": 95,
                    "matched": 95,
                    "missing_in_stockvision": 0,
                    "missing_in_finlab": 0,
                    "value_conflicts": 0,
                    "schema_extra_fields": [],
                },
            },
            {
                "dataset_lane": "trading_restrictions",
                "source": "finlab",
                "generated_at": "2026-07-05T10:31:00+00:00",
                "summary": {
                    "finlab_rows": 0,
                    "stockvision_rows": 0,
                    "matched": 0,
                    "missing_in_stockvision": 0,
                    "missing_in_finlab": 0,
                    "value_conflicts": 0,
                    "schema_extra_fields": [],
                },
            },
        ],
    }

    tool.insert_d1_summary(manifest)

    source_quality_calls = [
        params for sql, params in calls if "INSERT INTO source_quality_metrics" in sql
    ]
    assert len(source_quality_calls) == 1
    source_quality = source_quality_calls[0]
    assert source_quality[1] == "trading_restrictions"
    assert source_quality[2] == "2026-07-03"
    assert source_quality[3] == "ok"
    assert source_quality[4] == 0.0
    metrics = json.loads(source_quality[9])
    assert metrics["finlab_rows"] == 95
    assert metrics["report_count"] == 2


def test_core_specs_include_finlab_wave2_official_replacement_keys():
    tool = _load_tool_module()
    fundamental = next(spec for spec in tool.CORE_SPECS if spec.lane == "fundamental_factor_diversity")
    revenue = next(spec for spec in tool.CORE_SPECS if spec.lane == "revenue")
    daily_price = next(spec for spec in tool.CORE_SPECS if spec.lane == "daily_price")
    emerging_price = next(spec for spec in tool.CORE_SPECS if spec.lane == "emerging_price_diversity")
    chip = next(spec for spec in tool.CORE_SPECS if spec.lane == "chip_diversity")
    global_context = next(spec for spec in tool.CORE_SPECS if spec.lane == "global_context")
    regime_context = next(spec for spec in tool.CORE_SPECS if spec.lane == "regime_context")
    trading_restrictions = next(
        spec for spec in tool.CORE_SPECS
        if spec.lane == "trading_restrictions" and "esb_attention_flag" in spec.keys
    )

    assert daily_price.keys["close"] == "price:收盤價"
    assert daily_price.keys["adj_open"] == "etl:adj_open"
    assert daily_price.keys["adj_high"] == "etl:adj_high"
    assert daily_price.keys["adj_low"] == "etl:adj_low"
    assert daily_price.keys["adj_close"] == "etl:adj_close"
    assert daily_price.keys["market_value"] == "etl:market_value"
    assert daily_price.keys["trade_count"] == "price:成交筆數"
    assert daily_price.keys["last_bid_price"] == "price:最後揭示買價"
    assert daily_price.keys["last_ask_volume"] == "price:最後揭示賣量"
    assert emerging_price.keys["avg_price"] == "rotc_price:日均價"
    assert emerging_price.keys["trade_count"] == "rotc_price:成交筆數"
    assert chip.keys["foreign_buy"] == "institutional_investors_trading_summary:外陸資買進股數(不含外資自營商)"
    assert chip.keys["foreign_sell"] == "institutional_investors_trading_summary:外陸資賣出股數(不含外資自營商)"
    assert chip.keys["trust_buy"] == "institutional_investors_trading_summary:投信買進股數"
    assert chip.keys["trust_sell"] == "institutional_investors_trading_summary:投信賣出股數"
    assert chip.keys["dealer_self_buy"] == "institutional_investors_trading_summary:自營商買進股數(自行買賣)"
    assert chip.keys["dealer_hedge_sell"] == "institutional_investors_trading_summary:自營商賣出股數(避險)"
    assert chip.keys["margin_buy"] == "margin_transactions:融資買進"
    assert chip.keys["margin_cash_repayment"] == "margin_transactions:融資現金償還"
    assert chip.keys["margin_usage_ratio"] == "margin_transactions:融資使用率"
    assert chip.keys["short_stock_repayment"] == "margin_transactions:融券現券償還"
    assert chip.keys["short_usage_ratio"] == "margin_transactions:融券使用率"
    assert chip.keys["margin_balance_total_balance"] == "margin_balance:融資券總餘額"
    assert chip.keys["security_lending_balance"] == "security_lending:借券餘額"
    assert chip.keys["security_lending_sell_balance"] == "security_lending_sell:借券賣出餘額"
    assert chip.keys["broker_top15_buy"] == "etl:broker_transactions:top15_buy"
    assert chip.keys["broker_top15_sell"] == "etl:broker_transactions:top15_sell"
    assert chip.keys["broker_buy_sell_ratio"] == "etl:broker_transactions:buy_sell_ratio"
    assert chip.keys["broker_balance_index"] == "etl:broker_transactions:balance_index"
    assert global_context.keys["world_adj_close"] == "world_index:adj_close"
    assert regime_context.keys["taiex_open"] == "taiex_total_index:開盤指數"
    assert regime_context.keys["taiex_high"] == "taiex_total_index:最高指數"
    assert regime_context.keys["taiex_low"] == "taiex_total_index:最低指數"
    assert regime_context.keys["taiex_close"] == "taiex_total_index:收盤指數"
    assert regime_context.keys["futures_inst_long_trade_lots"] == "futures_institutional_investors_trading_summary:多方交易口數"
    assert regime_context.keys["futures_inst_net_oi_amount_k"] == "futures_institutional_investors_trading_summary:多空未平倉契約金額淨額(千元)"
    assert trading_restrictions.keys["esb_attention_flag"] == "esb_attention_disposal:注意有價證券"
    assert trading_restrictions.keys["esb_disposition_flag"] == "esb_attention_disposal:處置有價證券"
    assert trading_restrictions.keys["esb_disposition_end"] == "esb_attention_disposal:處置結束時間"
    assert revenue.keys["revenue"] == "monthly_revenue:當月營收"
    assert revenue.keys["previous_month_revenue"] == "monthly_revenue:上月營收"
    assert revenue.keys["last_year_cumulative_revenue"] == "monthly_revenue:去年累計營收"
    assert revenue.keys["previous_comparison_pct"] == "monthly_revenue:前期比較增減(%)"
    assert fundamental.keys["pe"] == "price_earning_ratio:本益比"
    assert fundamental.keys["pb"] == "price_earning_ratio:股價淨值比"
    assert fundamental.keys["dividend_yield"] == "price_earning_ratio:殖利率(%)"
    assert fundamental.keys["revenue"] == "financial_statement:營業收入淨額"
    assert fundamental.keys["operating_income"] == "financial_statement:營業利益"
    assert fundamental.keys["net_income"] == "financial_statement:歸屬母公司淨利_損"
    assert fundamental.keys["net_margin"] == "fundamental_features:稅後淨利率"
    assert fundamental.keys["quick_ratio"] == "fundamental_features:速動比率"
    assert fundamental.keys["inventory_turnover"] == "fundamental_features:存貨週轉率"
    assert fundamental.keys["roe_comprehensive"] == "fundamental_features:ROE綜合損益"


def test_official_market_summary_parser_materializes_margin_and_breadth(monkeypatch):
    tool = _load_tool_module()

    def fake_json_get(url, *, label, timeout=30.0):
        if "twtazu_od" in url:
            return [{"市場": "上市股票", "出表日期": "1150626", "上漲": "291", "持平": "84", "下跌": "1965"}]
        if "MI_MARGN" in url:
            return {
                "stat": "OK",
                "date": "20260626",
                "tables": [
                    {},
                    {
                        "data": [
                            ["2330", "台積電", "1", "2", "3", "4", "5", "6", "7", "8", "9", "10", "11"],
                            ["2317", "鴻海", "10", "20", "30", "40", "50", "60", "70", "80", "90", "100", "110"],
                        ]
                    },
                ],
            }
        if "tpex_mainboard_margin_balance" in url:
            return [
                {
                    "Date": "20260626",
                    "SecuritiesCompanyCode": "6488",
                    "MarginPurchase": "2",
                    "MarginSales": "3",
                    "MarginPurchaseBalance": "4",
                    "ShortBuy": "5",
                    "ShortSale": "6",
                    "ShortSaleBalance": "7",
                }
            ]
        return []

    monkeypatch.setattr(tool, "official_json_get", fake_json_get)
    monkeypatch.setattr(tool, "recent_calendar_dates", lambda _days: ["2026-06-26"])
    frames = tool.fetch_official_market_summary_frames(lookback_days=1)

    assert set(frames) == {"market_breadth_summary", "twse_margin_trading_summary", "tpex_margin_trading_summary"}
    assert frames["market_breadth_summary"].iloc[0]["advance_count"] == 291
    assert frames["twse_margin_trading_summary"].iloc[0]["margin_balance_units"] == 55
    assert frames["tpex_margin_trading_summary"].iloc[0]["short_balance_units"] == 7


def test_official_market_summary_required_validator_fails_when_tpex_missing():
    tool = _load_tool_module()
    frames = {
        "twse_margin_trading_summary": pd.DataFrame([{
            "date": "2026-07-01",
            "market_segment": "LISTED",
            "margin_balance_units": 1,
        }]),
    }

    try:
        tool.validate_official_market_summary_frames(frames, target_date="2026-07-01")
    except RuntimeError as exc:
        assert "official_market_summary_missing" in str(exc)
        assert "tpex_margin_trading_summary=missing" in str(exc)
    else:
        raise AssertionError("required official market summary validator must fail when OTC/TPEX is missing")


def test_official_twse_index_parser_materializes_taiex_history(monkeypatch):
    tool = _load_tool_module()

    def fake_json_get(url, *, label, timeout=30.0):
        assert "MI_5MINS_HIST" in url
        return {
            "stat": "OK",
            "data": [
                ["115/06/29", "44,594.81", "45,521.63", "44,594.81", "44,999.90"],
            ],
        }

    monkeypatch.setattr(tool, "official_json_get", fake_json_get)
    monkeypatch.setattr(tool, "taipei_today", lambda: "2026-06-30")

    frame = tool.fetch_official_twse_index_frame()

    assert frame.iloc[0]["date"] == "2026-06-29"
    assert frame.iloc[0]["symbol"] == "TWII"
    assert frame.iloc[0]["close"] == 44999.90


def test_write_parquet_ignores_nonserializable_dataframe_attrs(tmp_path):
    tool = _load_tool_module()
    frame = pd.DataFrame({"date": ["2026-06-26"], "stock_id": ["2330"]})
    rank_rows = pd.DataFrame({"rank_side": ["buy"], "rank_no": [1]})
    frame.attrs["broker_rank_daily"] = rank_rows

    path = tmp_path / "broker_daily.parquet"
    tool.write_parquet(path, frame)

    assert path.exists()
    assert frame.attrs["broker_rank_daily"].equals(rank_rows)


def test_latest_index_uses_date_column_before_range_index():
    tool = _load_tool_module()
    frame = pd.DataFrame({"date": ["2026-06-28", "2026-06-29"], "close": [100.0, 101.0]})

    assert tool.latest_index(frame) == "2026-06-29"


def test_latest_index_does_not_parse_plain_numeric_index_as_epoch_date():
    tool = _load_tool_module()
    frame = pd.DataFrame({"close": [100.0, 101.0]})

    assert tool.latest_index(frame) is None


def test_apply_canonical_d1_waits_for_source_key_report_but_not_summary_writeback():
    source = TOOL_PATH.read_text(encoding="utf-8")

    assert 'manifest["source_key_report_writeback"] = insert_source_key_report' in source
    assert "\n    if args.apply_canonical_d1:" in source
    assert source.index('manifest["source_key_report_writeback"] = insert_source_key_report') < source.index("if args.apply_canonical_d1:")
    assert "materialize_canonical_plan_to_d1" in source
    assert "source_key_blockers=source_key_blockers" in source
    assert 'if manifest["canonical_d1_apply"].get("status") == "ready":' in source
    assert 'manifest["backfill_status"] = "partial_failed"' in source
    assert "validate_canonical_apply_result(manifest.get(\"canonical_d1_apply\"), dry_run=args.canonical_dry_run)" in source
    assert source.index("validate_canonical_apply_result(manifest.get(\"canonical_d1_apply\")") < source.index("insert_d1_summary(manifest)")


def test_finlab_source_contract_drives_required_fields_and_flags():
    tool = _load_tool_module()

    assert tool.FINLAB_SOURCE_CONTRACT["schema_version"] == "stockvision-finlab-source-contract-v1"
    assert tool.finlab_contract_flag_default("FINLAB_KEY_REPORT_ENABLED") is True
    assert tool.finlab_contract_flag_default("FINLAB_KEY_LEVEL_RETRY_ENABLED") is True
    assert tool.finlab_contract_flag_default("FINLAB_ARTIFACT_REUSE_ENABLED") is True
    assert tool.REQUIRED_ATOMIC_WIDE_FIELDS["institutional_amount_summary"] == {"buy_amount", "sell_amount", "net_amount"}
    assert tool.source_key_required("daily_price", "close") is True
    assert tool.source_key_required("daily_price", "trade_count") is False


def test_source_key_status_for_exception_classifies_schema_and_quota():
    tool = _load_tool_module()

    assert tool.source_key_status_for_exception(RuntimeError('ColumnNotFoundError: unable to find column "buy_amount"')) == "schema_mismatch"
    assert tool.source_key_status_for_exception(RuntimeError("Usage exceed 5000 MB/day")) == "quota_blocked"
    assert tool.source_key_status_for_exception(RuntimeError("temporary network issue")) == "failed"


def test_validate_canonical_apply_result_rejects_zero_row_ready_false_positive():
    tool = _load_tool_module()

    try:
        tool.validate_canonical_apply_result(
            {
                "statement_count": 0,
                "row_counts": {"canonical_market_daily": 0},
                "apply_result": {"success_count": 0, "error_count": 0},
            }
        )
    except RuntimeError as exc:
        assert "wrote no D1 statements" in str(exc)
    else:
        raise AssertionError("canonical D1 apply with no writes must not be accepted as ready")


def test_validate_canonical_apply_result_rejects_d1_batch_errors():
    tool = _load_tool_module()

    try:
        tool.validate_canonical_apply_result(
            {
                "statement_count": 3,
                "row_counts": {"canonical_market_daily": 3},
                "apply_result": {"success_count": 2, "error_count": 1},
            }
        )
    except RuntimeError as exc:
        assert "canonical_d1_apply failed" in str(exc)
    else:
        raise AssertionError("canonical D1 apply with batch errors must not be accepted as ready")


def test_required_institutional_amount_fields_fail_closed_when_partial():
    tool = _load_tool_module()
    frames = {
        "sell_amount": pd.DataFrame({"foreign": [70.0]}, index=pd.to_datetime(["2026-07-03"])),
        "net_amount": pd.DataFrame({"foreign": [30.0]}, index=pd.to_datetime(["2026-07-03"])),
    }

    try:
        tool.validate_required_wide_field_completeness(
            "institutional_amount_summary",
            frames,
            target_date="2026-07-03",
        )
    except RuntimeError as exc:
        assert "finlab_required_wide_field_incomplete" in str(exc)
        assert "buy_amount=missing" in str(exc)
    else:
        raise AssertionError("partial institutional_amount_summary artifacts must fail closed")


def test_required_institutional_amount_fields_validate_target_date():
    tool = _load_tool_module()
    frames = {
        "buy_amount": pd.DataFrame({"foreign": [100.0]}, index=pd.to_datetime(["2026-07-02"])),
        "sell_amount": pd.DataFrame({"foreign": [70.0]}, index=pd.to_datetime(["2026-07-03"])),
        "net_amount": pd.DataFrame({"foreign": [30.0]}, index=pd.to_datetime(["2026-07-03"])),
    }

    try:
        tool.validate_required_wide_field_completeness(
            "institutional_amount_summary",
            frames,
            target_date="2026-07-03",
        )
    except RuntimeError as exc:
        assert "buy_amount=missing_target_date:2026-07-03" in str(exc)
    else:
        raise AssertionError("required field with stale-only data must fail closed")


def test_key_scope_json_limits_finlab_data_get_fields():
    tool = _load_tool_module()
    spec = next(spec for spec in tool.CORE_SPECS if spec.lane == "institutional_amount_summary")
    scope = tool.parse_key_scope_json('[{"lane":"institutional_amount_summary","fields":["buy_amount"]}]')

    assert scope == {"institutional_amount_summary": {"buy_amount"}}
    assert tool.spec_keys_for_scope(spec, scope) == {"buy_amount": spec.keys["buy_amount"]}


def test_key_scope_json_empty_fields_keeps_lane_full_fetch():
    tool = _load_tool_module()
    spec = next(spec for spec in tool.CORE_SPECS if spec.lane == "daily_price")
    scope = tool.parse_key_scope_json('[{"lane":"daily_price","fields":[]},{"lane":"fundamental_factor_diversity","fields":["pe","pb"]}]')

    assert tool.spec_keys_for_scope(spec, scope) == spec.keys


def test_source_key_report_writeback_records_attempt_and_latest_state(monkeypatch):
    tool = _load_tool_module()
    captured = {}

    def fake_batch_execute(statements, **kwargs):
        captured["statements"] = statements
        captured["kwargs"] = kwargs
        return {"success_count": len(statements), "error_count": 0}

    monkeypatch.setattr(tool, "d1_batch_execute", fake_batch_execute)
    manifest = {
        "source_key_reports": [{
            "run_id": "finlab-v4-daily-20260703-test",
            "target_date": "2026-07-03",
            "lane": "institutional_amount_summary",
            "canonical_dataset": "canonical_institutional_amount_daily",
            "field": "buy_amount",
            "api_key": "institutional_investors_trading_summary:buy",
            "source": "finlab",
            "required": 1,
            "status": "failed",
            "rows": 0,
            "target_rows": 0,
            "latest_date": None,
            "artifact_uri": None,
            "artifact_path": None,
            "artifact_checksum": None,
            "error_code": "ColumnNotFoundError",
            "error_message": "unable to find column buy_amount",
            "generated_at": "2026-07-03T10:34:00+00:00",
            "metadata_json": "{}",
        }],
    }

    result = tool.insert_source_key_report(manifest)

    assert result["status"] == "written"
    assert result["rows"] == 1
    assert captured["kwargs"]["domain"] == "ops"
    assert len(captured["statements"]) == 2
    assert "INSERT INTO source_key_attempts" in captured["statements"][0][0]
    assert "INSERT INTO source_key_report" in captured["statements"][1][0]


def test_reuse_ready_field_artifacts_completes_partial_institutional_lane(monkeypatch, tmp_path):
    tool = _load_tool_module()
    previous_dir = tmp_path / "previous"
    previous_dir.mkdir()
    sell_path = previous_dir / "sell_amount.parquet"
    net_path = previous_dir / "net_amount.parquet"
    pd.DataFrame({"foreign": [70.0]}, index=pd.to_datetime(["2026-07-03"])).to_parquet(sell_path)
    pd.DataFrame({"foreign": [30.0]}, index=pd.to_datetime(["2026-07-03"])).to_parquet(net_path)
    for key in ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"):  # reuse lookup needs D1 credentials
        monkeypatch.setenv(key, "test-only")

    def fake_d1_query(_sql, params=None, **kwargs):
        assert kwargs.get("domain") == "ops"
        assert params[:2] == ["2026-07-03", "institutional_amount_summary"]
        return [
            {
                "field": "sell_amount",
                "api_key": "sell_api",
                "status": "ok",
                "rows": 1,
                "target_rows": 1,
                "latest_date": "2026-07-03",
                "artifact_path": str(sell_path),
                "artifact_uri": None,
                "artifact_checksum": tool.file_sha256(sell_path),
                "last_run_id": "previous-run",
            },
            {
                "field": "net_amount",
                "api_key": "net_api",
                "status": "ok",
                "rows": 1,
                "target_rows": 1,
                "latest_date": "2026-07-03",
                "artifact_path": str(net_path),
                "artifact_uri": None,
                "artifact_checksum": tool.file_sha256(net_path),
                "last_run_id": "previous-run",
            },
        ]

    monkeypatch.setattr(tool, "d1_query", fake_d1_query)
    field_frames = {
        "buy_amount": pd.DataFrame({"foreign": [100.0]}, index=pd.to_datetime(["2026-07-03"])),
    }
    artifacts, reports = tool.reuse_ready_field_artifacts(
        run_id="current-run",
        generated_at="2026-07-03T11:00:00+00:00",
        target_date="2026-07-03",
        lane="institutional_amount_summary",
        lane_dir=tmp_path / "current" / "raw" / "institutional_amount_summary",
        requested_field_frames=field_frames,
        all_keys={
            "buy_amount": "buy_api",
            "sell_amount": "sell_api",
            "net_amount": "net_api",
        },
        run_dir=tmp_path / "current",
        gcs_bucket=None,
        gcs_prefix=None,
    )

    assert sorted(field_frames) == ["buy_amount", "net_amount", "sell_amount"]
    assert not tool.required_wide_field_errors("institutional_amount_summary", field_frames, target_date="2026-07-03")
    assert [artifact["field"] for artifact in artifacts] == ["sell_amount", "net_amount"]
    assert {report["status"] for report in reports} == {"skipped_reused"}


def test_materialize_canonical_plan_applies_ready_datasets_and_marks_blocked(monkeypatch):
    tool = _load_tool_module()
    called = []

    def fake_materialize(_manifest, *, datasets, **_kwargs):
        called.extend(datasets)
        dataset = datasets[0]
        return {
            "statement_count": 1,
            "row_counts": {dataset: 3},
            "apply_result": {"total": 1, "success_count": 1, "error_count": 0, "changes_total": 3},
        }

    monkeypatch.setattr(tool, "materialize_canonical_to_d1", fake_materialize)
    manifest = {
        "run_id": "finlab-v4-daily-20260703-test",
        "generated_at": "2026-07-03T11:00:00+00:00",
        "artifact_root": "/tmp/finlab-test",
    }
    result = tool.materialize_canonical_plan_to_d1(
        manifest,
        start_date="2026-07-03",
        end_date="2026-07-03",
        datasets=["canonical_market_daily", "canonical_institutional_amount_daily"],
        source_key_blockers=[{"lane": "institutional_amount_summary", "reason": "required_wide_field_incomplete"}],
        dry_run=False,
    )

    assert result["status"] == "partial_failed"
    assert called == ["canonical_market_daily"]
    assert result["materialized_datasets"] == ["canonical_market_daily"]
    assert result["blocked_datasets"] == ["canonical_institutional_amount_daily"]
    assert result["per_dataset"]["canonical_institutional_amount_daily"]["status"] == "materializer_blocked"


def test_materialize_canonical_plan_caps_wide_fundamental_chunk_size(monkeypatch):
    tool = _load_tool_module()
    calls = []

    def fake_materialize(_manifest, *, datasets, chunk_size, **_kwargs):
        dataset = datasets[0]
        calls.append((dataset, chunk_size))
        return {
            "statement_count": 1,
            "row_counts": {dataset: 3},
            "apply_result": {"total": 1, "success_count": 1, "error_count": 0, "changes_total": 3},
        }

    monkeypatch.setattr(tool, "materialize_canonical_to_d1", fake_materialize)
    manifest = {
        "run_id": "finlab-v4-daily-20260707-test",
        "generated_at": "2026-07-07T13:00:00+00:00",
        "artifact_root": "/tmp/finlab-test",
    }

    result = tool.materialize_canonical_plan_to_d1(
        manifest,
        start_date="2026-07-07",
        end_date="2026-07-07",
        datasets=["canonical_market_daily", "canonical_fundamental_features"],
        source_key_blockers=[],
        chunk_size=250,
        dry_run=False,
    )

    assert calls == [
        ("canonical_market_daily", 250),
        ("canonical_fundamental_features", 10),
    ]
    assert result["per_dataset"]["canonical_fundamental_features"]["chunk_size"] == 10
    assert result["per_dataset"]["canonical_market_daily"]["chunk_size"] == 250


def test_materialize_canonical_plan_uses_direct_trading_restrictions_owner(monkeypatch):
    tool = _load_tool_module()
    monkeypatch.setattr(tool, "materialize_canonical_to_d1", lambda *_args, **_kwargs: pytest.fail("generic owner must not run"))
    monkeypatch.setattr(tool, "insert_finlab_trading_restrictions", lambda _manifest: 12)
    manifest = {"run_id": "finlab-v4-daily-20260720-test", "generated_at": "2026-07-20T13:00:00+00:00", "artifact_root": "/tmp/finlab-test"}
    result = tool.materialize_canonical_plan_to_d1(manifest, start_date="2026-07-20", end_date="2026-07-20", datasets=["canonical_trading_restrictions"], source_key_blockers=[], dry_run=False)
    assert result["status"] == "ready"
    assert result["row_counts"]["canonical_trading_restrictions"] == 12
    assert result["per_dataset"]["canonical_trading_restrictions"]["materializer"] == "finlab_trading_restrictions_direct"


def test_materialize_canonical_plan_marks_all_blocked_without_throwing():
    tool = _load_tool_module()
    manifest = {
        "run_id": "finlab-v4-daily-20260703-test",
        "generated_at": "2026-07-03T11:00:00+00:00",
        "artifact_root": "/tmp/finlab-test",
    }

    result = tool.materialize_canonical_plan_to_d1(
        manifest,
        start_date="2026-07-03",
        end_date="2026-07-03",
        datasets=["canonical_institutional_amount_daily"],
        source_key_blockers=[{"lane": "institutional_amount_summary", "reason": "required_wide_field_incomplete"}],
        dry_run=False,
    )

    assert result["status"] == "materializer_blocked"
    assert result["statement_count"] == 0
    assert result["materialized_datasets"] == []
    assert result["blocked_datasets"] == ["canonical_institutional_amount_daily"]

def test_broker_raw_observation_distinguishes_provider_delay_from_normalized_empty():
    tool = _load_tool_module()
    raw = pd.DataFrame({"date": ["2026-09-18"], "stock_id": ["2330"],
                        "broker": ["A"], "buy": [1000], "sell": [500]})
    observation = tool.broker_source_observation(raw, "2026-09-21")
    assert observation["required_columns_valid"] is True
    assert observation["raw_rows"] == observation["valid_date_rows"] == 1
    assert observation["raw_max_date"] == "2026-09-18"
    assert observation["target_rows"] == 0
    assert tool.normalize_broker_transactions_daily(raw, "2026-09-21").empty
    assert not tool.broker_source_observation(raw.drop(columns=["buy"]), "2026-09-21")["required_columns_valid"]
    raw.loc[0, "date"] = "invalid"
    assert tool.broker_source_observation(raw, "2026-09-21")["valid_date_rows"] == 0



def test_actual_daily_materialize_entry_seals_full_market_cap_history(monkeypatch,tmp_path):
    from types import SimpleNamespace
    tool=_load_tool_module()
    days=pd.to_datetime(["2026-09-28","2026-09-29"])
    source=pd.DataFrame({str(symbol):[100.,101.] for symbol in range(3000,3100)},index=days)
    monkeypatch.setitem(sys.modules,"finlab",SimpleNamespace(data=SimpleNamespace(get=lambda key:source.copy()),login=lambda:None))
    monkeypatch.setattr(tool,"login_finlab_sdk",lambda login:None)
    monkeypatch.setattr(tool,"d1_counts",lambda start:{})
    monkeypatch.setattr(tool,"start_date_for_years",lambda years:"2026-09-01")
    from test_training_session_calendar import calendar_fixture
    calendar,_=calendar_fixture()
    def official(url,**kwargs):
        if "type=MS" in url:
            from urllib.parse import urlparse,parse_qs
            day=parse_qs(urlparse(url).query)["date"][0]
            return {"stat":"OK","date":day,"tables":[{"fields":["類型","整體市場","股票"],"data":[["上漲","90","60"],["下跌","90","40"]]}]}
        market="TWSE" if "twse.com" in url else "TPEX"
        return json.loads(calendar.data[f"capture/raw/daily_price_full_vintage/official_calendar/{market}-2026-09.json"])
    monkeypatch.setattr(tool,"official_json_get",official)
    from services import training_us_capture
    monkeypatch.setattr(training_us_capture,"write_us_quote_capture",lambda **kw: None)
    monkeypatch.setattr(tool.time,"sleep",lambda seconds:None)
    tool.materialize_specs(years=4,run_dir=tmp_path,lanes=["daily_price"],
        source_start_date="2026-09-29",source_end_date="2026-09-29")
    manifest=json.loads((tmp_path/"raw/daily_price_full_vintage/manifest.json").read_text())
    assert "market_value" in manifest["checksums"]
    full=pd.read_parquet(tmp_path/"raw/daily_price_full_vintage/market_value.parquet")
    daily=pd.read_parquet(tmp_path/"raw/daily_price/market_value.parquet")
    assert list(full.index.strftime("%Y-%m-%d"))==["2026-09-28","2026-09-29"]
    assert list(daily.index.strftime("%Y-%m-%d"))==["2026-09-29"]
    assert full["3004"].tolist()==[100.,101.]


def test_daily_materialize_retains_auxiliary_history_before_daily_canonical_clip(monkeypatch, tmp_path):
    from types import SimpleNamespace
    tool = _load_tool_module()
    days = pd.to_datetime(['2026-10-12', '2026-10-13'])
    frame = pd.DataFrame({'2330': [0., 2.]}, index=days)
    monkeypatch.setitem(sys.modules, 'finlab', SimpleNamespace(data=SimpleNamespace(get=lambda _: frame.copy()), login=lambda: None))
    monkeypatch.setattr(tool, 'login_finlab_sdk', lambda _: None)
    monkeypatch.setattr(tool, 'd1_counts', lambda _: {})
    monkeypatch.setattr(tool, 'start_date_for_years', lambda _: '2023-10-13')
    monkeypatch.setattr(tool, 'required_wide_field_errors', lambda *a, **kw: [])
    tool.materialize_specs(years=3, run_dir=tmp_path, lanes=['fundamental_factor_diversity'],
        source_start_date='2026-10-13', source_end_date='2026-10-13', daily_refresh=True,
        key_scope={'fundamental_factor_diversity': {'pe', 'pb'}})
    full = pd.read_parquet(tmp_path / 'raw/training_auxiliary_full_vintage/pe.parquet')
    canonical = pd.read_parquet(tmp_path / 'raw/fundamental_factor_diversity/pe.parquet')
    assert full['2330'].tolist() == [0., 2.]
    assert canonical['2330'].tolist() == [2.]


def _legacy_normalize_broker(tool, frame, start):
    """Pre-window implementation, kept verbatim as the output oracle."""
    date_col = tool._first_existing_column(frame, ("date", "日期", "trade_date"))
    stock_col = tool._first_existing_column(frame, ("stock_id", "symbol", "股票代號", "證券代號"))
    broker_col = tool._first_existing_column(frame, ("broker", "broker_code", "securities_broker", "分點", "券商", "證券商"))
    buy_col = tool._first_existing_column(frame, ("buy_shares", "buy_volume", "buy_qty", "buy", "買進股數", "買進張數"))
    sell_col = tool._first_existing_column(frame, ("sell_shares", "sell_volume", "sell_qty", "sell", "賣出股數", "賣出張數"))
    out = frame.copy()
    out["date"] = pd.to_datetime(out[date_col], errors="coerce")
    out = out[out["date"] >= pd.Timestamp(start)]
    out["stock_id"] = [tool._clean_symbol(row.get(stock_col), row) for row in out.to_dict(orient="records")]
    out["broker_code"] = out[broker_col].astype(str).str.strip() if broker_col else "unknown"
    out["buy_shares_raw"] = pd.to_numeric(out[buy_col], errors="coerce").fillna(0)
    out["sell_shares_raw"] = pd.to_numeric(out[sell_col], errors="coerce").fillna(0)
    out["broker_net"] = out["buy_shares_raw"] - out["sell_shares_raw"]
    out = out[(out["stock_id"] != "") & out["date"].notna()]
    if out.empty:
        return pd.DataFrame()
    broker_daily = out.groupby(["date", "stock_id", "broker_code"], observed=True).agg(
        broker_buy_shares=("buy_shares_raw", "sum"), broker_sell_shares=("sell_shares_raw", "sum"),
        broker_net=("broker_net", "sum")).reset_index()
    broker_daily["abs_broker_net"] = broker_daily["broker_net"].abs()
    dominant = (broker_daily.sort_values(["date", "stock_id", "abs_broker_net"], ascending=[True, True, False])
        .groupby(["date", "stock_id"], observed=True).head(1)[["date", "stock_id", "broker_code", "broker_net", "abs_broker_net"]]
        .rename(columns={"broker_code": "dominant_broker_code", "broker_net": "dominant_net_shares",
                         "abs_broker_net": "dominant_abs_net_shares"}))
    pressure = broker_daily.groupby(["date", "stock_id"], observed=True).agg(
        gross_imbalance_shares=("abs_broker_net", "sum"),
        directional_broker_count=("abs_broker_net", lambda values: int((values > 0).sum()))).reset_index()
    grouped = out.groupby(["date", "stock_id"], observed=True).agg(
        buy_shares=("buy_shares_raw", "sum"), sell_shares=("sell_shares_raw", "sum"),
        broker_count=("broker_code", "nunique")).reset_index()
    grouped = grouped.merge(dominant, on=["date", "stock_id"], how="left").merge(pressure, on=["date", "stock_id"], how="left")
    grouped["buy_sell_net"] = grouped["dominant_net_shares"].fillna(0)
    grouped["source"] = "finlab.broker_transactions"
    grouped["market_segment"] = "LISTED_OTC"
    grouped.attrs["broker_rank_daily"] = tool.build_broker_rank_daily(
        broker_daily, market_segment="LISTED_OTC", source="finlab.broker_transactions")
    return grouped


def _synthetic_broker_frame(string_dates=False):
    import numpy as np
    rng = np.random.default_rng(7)
    days = pd.bdate_range("2026-07-20", "2026-09-30")
    symbols = ["2330", "2330 台積電", "00878", "6488", "invalid", None]
    brokers = ["1020", " 1020", "9A00", "1030", "8440 "]
    rows = []
    for day in days:
        for symbol in symbols:
            for broker in brokers:
                buy, sell = float(rng.integers(0, 6) * 1000), float(rng.integers(0, 6) * 1000)
                rows.append([day, symbol, broker, buy, sell])
        # Exact |net| tie with opposite signs on the same symbol/day.
        rows.append([day, "3008", "1020", 5000.0, 0.0])
        rows.append([day, "3008", "9A00", 0.0, 5000.0])
    frame = pd.DataFrame(rows, columns=["date", "symbol", "broker", "buy", "sell"])
    frame.loc[3, "buy"] = float("nan")
    frame.loc[11, "sell"] = None
    frame.loc[17, "date"] = pd.NaT
    frame = frame.sample(frac=1.0, random_state=3).reset_index(drop=True)
    frame["stock_id"] = frame["symbol"]
    if string_dates:
        frame["date"] = frame["date"].dt.strftime("%Y-%m-%d")
    return frame


@pytest.mark.parametrize("string_dates", [False, True])
def test_windowed_broker_normalization_matches_single_pass(tmp_path, string_dates):
    import hashlib
    tool = _load_tool_module()
    frame = _synthetic_broker_frame(string_dates)
    before = frame.copy()
    expected = _legacy_normalize_broker(tool, frame, "2026-08-03")
    actual = tool.normalize_broker_transactions_daily(frame, "2026-08-03")
    pd.testing.assert_frame_equal(frame, before)
    pd.testing.assert_frame_equal(actual, expected)
    pd.testing.assert_frame_equal(actual.attrs["broker_rank_daily"], expected.attrs["broker_rank_daily"])
    assert expected["date"].nunique() > 14
    for name, left, right in (("daily", actual, expected),
                              ("rank", actual.attrs["broker_rank_daily"], expected.attrs["broker_rank_daily"])):
        a, b = tmp_path / f"{name}-new.parquet", tmp_path / f"{name}-old.parquet"
        tool.write_parquet(a, tool.filter_rows_date_range(left, start_date="2026-08-03", end_date="2026-09-29"))
        tool.write_parquet(b, tool.filter_rows_date_range(right, start_date="2026-08-03", end_date="2026-09-29"))
        assert hashlib.sha256(a.read_bytes()).hexdigest() == hashlib.sha256(b.read_bytes()).hexdigest()
    assert tool.normalize_broker_transactions_daily(frame, "2026-12-01").empty


def test_filter_rows_date_range_matches_copy_first_version():
    import warnings
    tool = _load_tool_module()
    frame = _synthetic_broker_frame()

    def legacy(df, start_date=None, end_date=None):
        out = pd.DataFrame(df).copy()
        if out.empty or "date" not in out.columns or (not start_date and not end_date):
            return out
        parsed = pd.to_datetime(out["date"], errors="coerce")
        mask = parsed.notna()
        if start_date:
            mask &= parsed >= pd.Timestamp(start_date)
        if end_date:
            mask &= parsed <= pd.Timestamp(end_date)
        return out[mask.to_numpy()].copy()

    for start, end in (("2026-08-03", "2026-09-29"), (None, None), ("2026-09-01", None)):
        actual = tool.filter_rows_date_range(frame, start_date=start, end_date=end)
        pd.testing.assert_frame_equal(actual, legacy(frame, start, end))
        assert actual is not frame
        with warnings.catch_warnings():
            warnings.simplefilter("error")
            actual["buy"] = -1.0
        assert (frame["buy"] != -1.0).all()


_D1_ENV = ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID", "FINLAB_CONTROLLER_TOKEN", "ML_CONTROLLER_TOKEN",
           "ML_CONTROLLER_SECRET", "FINLAB_CONTROLLER_D1_QUERY_URL", "ML_CONTROLLER_D1_QUERY_URL")


def _no_d1_env(monkeypatch, tmp_path, *extra):
    for key in (*_D1_ENV, "GCS_BUCKET_NAME", "FINLAB_DAILY_HISTORY_BOOTSTRAP_REF"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("FINLAB_API_KEY", "test-only")
    monkeypatch.setattr(sys, "argv", ["finlab_v4_remote_backfill.py", "--years", "3", "--run-id", "no-d1",
                                      "--output-dir", str(tmp_path), *extra])


def test_read_only_run_without_d1_credentials_skips_d1_and_records_it(monkeypatch, tmp_path):
    tool = _load_tool_module()
    _no_d1_env(monkeypatch, tmp_path)

    def forbidden(*args, **kwargs):
        raise AssertionError("d1_touched_without_credentials")

    for name in ("market_d1_query", "ops_d1_query", "d1_query", "d1_request", "d1_exec"):
        monkeypatch.setattr(tool, name, forbidden)

    def materialize(**kwargs):
        assert tool.d1_counts("2023-10-25") is None
        assert tool.read_ready_source_key_artifacts(target_date="2026-10-28", lane="broker", fields=["x"]) == {}
        diff = {"summary": {"missing_in_stockvision": None, "value_conflicts": 0}}
        return [{"finlab_rows": 3, "stockvision_rows": None}], [diff], [], []

    monkeypatch.setattr(tool, "materialize_specs", materialize)
    assert tool.main() == 0
    manifest = json.loads((tmp_path / "no-d1" / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["d1_unavailable"] == {"reason": "no_d1_credentials", "stockvision_rows_observed": False,
                                          "skipped": ["d1_counts", "source_key_report_reuse"]}
    assert manifest["summary"]["missing_in_stockvision"] == 0 and "gcs_upload" not in manifest


@pytest.mark.parametrize("flag", ["--write-d1", "--apply-canonical-d1"])
def test_d1_writing_run_without_credentials_still_exits_missing_env(monkeypatch, tmp_path, flag):
    tool = _load_tool_module()
    _no_d1_env(monkeypatch, tmp_path, flag)
    monkeypatch.setattr(tool, "materialize_specs", lambda **kwargs: pytest.fail("must exit before fetching"))
    with pytest.raises(SystemExit, match="missing env vars: CF_API_TOKEN,CF_ACCOUNT_ID,CF_D1_DB_ID"):
        tool.main()


def test_d1_counts_unchanged_when_credentials_exist(monkeypatch):
    tool = _load_tool_module()
    for key in _D1_ENV:
        monkeypatch.delenv(key, raising=False)
    for key in ("CF_API_TOKEN", "CF_ACCOUNT_ID", "CF_D1_DB_ID"):
        monkeypatch.setenv(key, "test-only")
    monkeypatch.setattr(tool, "market_d1_query", lambda sql, params: [{"n": 7}])
    counts = tool.d1_counts("2023-10-25")
    assert counts["daily_price"] == 7 and tool.D1_UNAVAILABLE_SKIPS == []


SIX_LANES = "daily_price,chip_diversity,revenue,fundamental_factor_diversity,training_shareholding,broker_flow_diversity"


def test_fundamental_training_fields_only_keeps_every_requested_lane(monkeypatch, tmp_path):
    tool = _load_tool_module()
    _no_d1_env(monkeypatch, tmp_path, "--lanes", SIX_LANES, "--fundamental-training-fields-only")
    seen = {}

    def materialize(**kwargs):
        seen.update(kwargs)
        return [], [], [], []

    monkeypatch.setattr(tool, "materialize_specs", materialize)
    assert tool.main() == 0
    lanes = SIX_LANES.split(",")
    assert set(seen["key_scope"]) == set(lanes) and set(seen["lanes"]) == set(lanes)
    fundamental = {"eps", "roe", "pe", "pb", "dividend_yield", "revenue_growth_yoy"}
    assert seen["key_scope"]["fundamental_factor_diversity"] == fundamental
    for spec in tool.CORE_SPECS:
        if spec.lane not in lanes:
            continue
        keys = tool.spec_keys_for_scope(spec, seen["key_scope"])
        if spec.lane == "fundamental_factor_diversity":
            financial = {k for k in keys.values() if k.startswith(tool.PIT_DEADLINE_NAMESPACES)}
            assert financial == {"fundamental_features:每股稅後淨利", "fundamental_features:ROE稅後", "fundamental_features:營收成長率"}
            assert "fundamental_features:營業費用率" not in keys.values()  # unconsumed ratio with vendor inf
        else:
            assert keys == dict(spec.keys)  # every other requested lane keeps all its keys

    for extra, reason in ((["--key-scope-json", '{"fundamental_factor_diversity":["eps"]}'],
                           "fundamental_training_fields_only_conflicts_with_key_scope_json"),
                          ([], "fundamental_training_fields_only_requires_explicit_fundamental_lane")):
        lanes_arg = SIX_LANES if extra else "daily_price"
        _no_d1_env(monkeypatch, tmp_path, "--lanes", lanes_arg, "--fundamental-training-fields-only", *extra)
        with pytest.raises(SystemExit, match=reason):
            tool.main()


def test_training_capture_fails_closed_when_requested_lane_is_skipped(monkeypatch, tmp_path):
    """A key_scope naming only one lane used to skip the rest and still report ready."""
    tool = _load_tool_module()
    sessions = pd.bdate_range("2026-10-01", "2026-10-22")
    frames = {}

    def get(key):
        if key not in frames:
            frames[key] = pd.DataFrame({"2330": np.arange(len(sessions), dtype=float) + 100.0}, index=sessions)
        return frames[key]

    monkeypatch.setitem(sys.modules, "finlab", SimpleNamespace(data=SimpleNamespace(get=get), login=lambda *a: None))
    monkeypatch.setattr(tool, "login_finlab_sdk", lambda fn: None)
    monkeypatch.setattr(tool, "d1_counts", lambda *a: None)
    for name in ("write_official_training_calendar", "write_training_breadth_capture"):
        monkeypatch.setattr(tool, name, lambda **kwargs: None)
    common = dict(years=3, lanes=["chip_diversity", "fundamental_factor_diversity"], source_start_date="2026-10-01",
                  source_end_date="2026-10-22", training_capture_start_date="2026-10-01")
    only_fundamental = {"fundamental_factor_diversity": {"pe", "pb"}}
    summaries, _, _, blockers = tool.materialize_specs(run_dir=tmp_path / "skipped", key_scope=only_fundamental, **common)
    assert [s["lane"] for s in summaries] == ["fundamental_factor_diversity"]
    assert {"lane": "chip_diversity", "reason": "requested_lane_produced_no_dataset"} in blockers
    both = {"chip_diversity": set(), **only_fundamental}
    summaries, _, _, blockers = tool.materialize_specs(run_dir=tmp_path / "both", key_scope=both, **common)
    assert sorted(s["lane"] for s in summaries) == ["chip_diversity", "fundamental_factor_diversity"]
    assert not [b for b in blockers if b.get("reason") == "requested_lane_produced_no_dataset"]


def test_monthly_revenue_required_field_uses_release_window_only_when_asked():
    tool = _load_tool_module()
    frame = pd.DataFrame({"2330": [1.0, 2.0]}, index=pd.to_datetime(["2026-09-10", "2026-10-12"]))
    target = "2026-10-22"
    assert tool.required_wide_field_errors("revenue", {"revenue": frame}, target_date=target) == [
        "revenue=missing_target_date:2026-10-22"]  # daily semantics unchanged
    assert tool.required_wide_field_errors("revenue", {"revenue": frame}, target_date=target,
                                           target_window_days=tool.MONTHLY_RELEASE_WINDOW_DAYS) == []
    stale = frame.loc[:"2026-09-10"]
    assert tool.required_wide_field_errors("revenue", {"revenue": stale}, target_date="2026-10-30",
                                           target_window_days=45) == ["revenue=missing_target_date:2026-10-30:window_days=45"]
    assert tool.MONTHLY_RELEASE_LANES == {"revenue"}
