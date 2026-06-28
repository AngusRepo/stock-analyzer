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


def test_write_parquet_ignores_nonserializable_dataframe_attrs(tmp_path):
    tool = _load_tool_module()
    frame = pd.DataFrame({"date": ["2026-06-26"], "stock_id": ["2330"]})
    rank_rows = pd.DataFrame({"rank_side": ["buy"], "rank_no": [1]})
    frame.attrs["broker_rank_daily"] = rank_rows

    path = tmp_path / "broker_daily.parquet"
    tool.write_parquet(path, frame)

    assert path.exists()
    assert frame.attrs["broker_rank_daily"].equals(rank_rows)


def test_apply_canonical_d1_is_not_gated_by_summary_writeback():
    source = TOOL_PATH.read_text(encoding="utf-8")

    assert "\n    if args.apply_canonical_d1:" in source
    assert source.index("if args.apply_canonical_d1") > source.index("if args.write_d1")
