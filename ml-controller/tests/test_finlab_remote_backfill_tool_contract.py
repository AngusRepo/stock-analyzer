from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pandas as pd


ROOT = Path(__file__).resolve().parents[2]
TOOL_PATH = ROOT / "tools" / "finlab_v4_remote_backfill.py"


def _load_tool_module():
    spec = importlib.util.spec_from_file_location("finlab_v4_remote_backfill_tool", TOOL_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def test_cleanup_finlab_trading_restrictions_tolerates_empty_d1_exec(monkeypatch):
    tool = _load_tool_module()

    monkeypatch.setattr(tool, "d1_exec", lambda _sql, _params=None: None)

    assert tool.cleanup_finlab_trading_restrictions(retention_days=31) == 0


def test_cleanup_finlab_trading_restrictions_reads_d1_changes(monkeypatch):
    tool = _load_tool_module()

    monkeypatch.setattr(tool, "TRADING_RESTRICTION_CLEANUP_ENABLED", True)
    monkeypatch.setattr(tool, "d1_exec", lambda _sql, _params=None: {"meta": {"changes": 7}})

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

    assert tool.insert_finlab_trading_restrictions(manifest, lookback_days=31, max_rows=20) == 2
    params = [item[1] for item in captured["statements"]]
    assert ["2330", "attention", "2026-06-30", "2026-07-31", "2026-06-30"] == params[0][:5]
    assert ["6586", "disposition", "2026-06-26", "2026-07-02", "2026-06-25"] == params[1][:5]


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


def test_source_quality_zero_finlab_rows_is_empty_not_ok(monkeypatch):
    tool = _load_tool_module()
    calls: list[tuple[str, list]] = []

    def fake_d1_exec(sql, params=None):
        calls.append((sql, list(params or [])))
        return {"success": True}

    monkeypatch.setattr(tool, "d1_exec", fake_d1_exec)
    manifest = {
        "run_id": "finlab-zero-row-test",
        "generated_at": "2026-07-02T10:30:00+00:00",
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
    assert source_quality[3] == "empty"
    assert source_quality[4] == 1.0


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
    assert tool.finlab_contract_flag_default("FINLAB_KEY_LEVEL_RETRY_ENABLED") is False
    assert tool.finlab_contract_flag_default("FINLAB_ARTIFACT_REUSE_ENABLED") is False
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

    def fake_d1_query(_sql, params=None):
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
                "artifact_checksum": "sha256:sell",
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
                "artifact_checksum": "sha256:net",
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
