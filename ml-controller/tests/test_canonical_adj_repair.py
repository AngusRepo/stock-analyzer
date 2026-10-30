import importlib.util
import sys
from pathlib import Path

import polars as pl

TOOL = Path(__file__).resolve().parents[2] / "tools" / "canonical_adj_repair.py"


def _tool():
    spec = importlib.util.spec_from_file_location("canonical_adj_repair_tool", TOOL)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


def _vintage():
    return pl.DataFrame(dict(stock_id=["2357", "2357", "2330"], date=["2026-05-15", "2026-09-24", "2026-09-24"],
                             close=[100.0, 110.0, 50.0], open=[99.0, 109.0, 49.0], high=[101.0, 111.0, 51.0],
                             low=[98.0, 108.0, 48.0], adj_close=[150.0, 165.0, 50.0], adj_open=[148.5, 163.5, 49.0]))


def test_only_null_or_stale_rows_are_written_and_as_of_date_is_kept():
    tool = _tool()
    canonical = [dict(stock_id="2357", date="2026-05-15", adj_close=None),
                 dict(stock_id="2357", date="2026-09-24", adj_close=165.0 / 1.4927),
                 dict(stock_id="2330", date="2026-09-24", adj_close=50.0),
                 dict(stock_id="9999", date="2026-09-24", adj_close=1.0)]
    legacy = [dict(stock_id=7, date="2026-05-15", adj_close=100.0),  # raw close stored as adjusted
              dict(stock_id=8, date="2026-09-24", adj_close=50.0)]
    report, statements = tool.plan_repair(_vintage(), canonical, legacy, {"2357": 7, "2330": 8}, capture_id="cap")
    assert report["canonical"] == {"null_filled": 1, "rebased": 1, "unchanged": 1, "not_in_capture": 1}
    assert report["legacy_stock_prices"] == {"rewritten": 1, "unchanged": 1}
    assert report["rebased_stocks"] == {"2357": [1.4927]}
    assert all("as_of_date" not in sql for sql, _ in statements)
    first = statements[0][1]
    assert first[:4] == [148.5, 151.5, 147.0, 150.0] and first[5:] == ["2357", "2026-05-15", "finlab.price"]
    assert statements[-1] == ("UPDATE stock_prices SET adj_close=? WHERE stock_id=? AND date=?", [150.0, 7, "2026-05-15"])


def test_emitted_sql_inlines_every_parameter(tmp_path):
    tool = _tool()
    statements = [("UPDATE t SET a=?, b=json(?) WHERE id=? AND d=?", [1.25, '{"k":"it\'s"}', 7, None])] * 3
    paths = tool.render_sql_files(statements, tmp_path, per_file=2)
    assert [p.name for p in paths] == ["adj_repair_000.sql", "adj_repair_001.sql"]
    lines = paths[0].read_text(encoding="utf-8").splitlines()
    assert lines[0] == "UPDATE t SET a=1.25, b=json('{\"k\":\"it''s\"}') WHERE id=7 AND d=NULL;"
    assert len(lines) == 2 and len(paths[1].read_text(encoding="utf-8").splitlines()) == 1
