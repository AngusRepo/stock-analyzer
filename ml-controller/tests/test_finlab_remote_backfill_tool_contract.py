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


def test_core_specs_include_finlab_wave2_official_replacement_keys():
    tool = _load_tool_module()
    fundamental = next(spec for spec in tool.CORE_SPECS if spec.lane == "fundamental_factor_diversity")
    revenue = next(spec for spec in tool.CORE_SPECS if spec.lane == "revenue")
    daily_price = next(spec for spec in tool.CORE_SPECS if spec.lane == "daily_price")
    emerging_price = next(spec for spec in tool.CORE_SPECS if spec.lane == "emerging_price_diversity")
    chip = next(spec for spec in tool.CORE_SPECS if spec.lane == "chip_diversity")
    global_context = next(spec for spec in tool.CORE_SPECS if spec.lane == "global_context")
    regime_context = next(spec for spec in tool.CORE_SPECS if spec.lane == "regime_context")

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
    assert regime_context.keys["futures_inst_long_trade_lots"] == "futures_institutional_investors_trading_summary:多方交易口數"
    assert regime_context.keys["futures_inst_net_oi_amount_k"] == "futures_institutional_investors_trading_summary:多空未平倉契約金額淨額(千元)"
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


def test_apply_canonical_d1_is_not_gated_by_summary_writeback():
    source = TOOL_PATH.read_text(encoding="utf-8")

    assert "\n    if args.apply_canonical_d1:" in source
    assert source.index("if args.apply_canonical_d1") > source.index("if args.write_d1")
