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

    assert tool.parse_lanes("daily_price, chip_diversity") == ["daily_price", "chip_diversity"]
    assert 'parser.add_argument("--lanes"' in source
    assert "spec.lane in requested_lanes" in source
    assert "unknown FinLab lanes" in source


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
