from dataclasses import replace
import importlib.util
from pathlib import Path
import sqlite3

import pytest

from services.finlab_canonical_materializer import materialize_finlab_canonical_outputs

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("l4_repair_planner", ROOT / "tools/plan_l4_canonical_session_repair.py")
planner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(planner)


def test_planner_repairs_full_prices_and_only_marks_wrong_horizons(tmp_path):
    output = materialize_finlab_canonical_outputs(tmp_path, datasets=["canonical_market_daily"])
    prices = [{"stock_id": str(i), "date": "2026-08-20", "open": 10., "high": 12., "low": 9.,
               "close": 11., "adj_close": 11., "volume": 1000., "source": "finlab.price"} for i in range(1, 101)]
    sessions = [{"session_date": date, "source_run_id": "original", "positive_close_count": 100,
                 "source_checksum": "verified-source", "observed_at": output.generated_at}
                for date in ["2026-08-13", "2026-08-14", "2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20"]]
    output = replace(output, canonical_market_daily=prices, source_sessions=sessions)
    inventory = {"stock_identities": [{"symbol": str(i), "id": i} for i in range(1, 101)], "labels": [
        {"stock_id": 1, "price_date": "2026-08-13", "entry_date": "2026-08-14", "exit_date": "2026-08-21"},
        {"stock_id": 2, "price_date": "2026-08-12", "entry_date": "2026-08-13", "exit_date": "2026-08-19"}]}
    plan = planner.plan_repair(output, inventory, "2026-08-20")
    assert plan["label_rerun_dates"] == ["2026-08-13"]
    assert plan["verified_unchanged_labels"] == 1
    assert plan["frozen_oof_artifacts_modified"] is False
    db = sqlite3.connect(":memory:")
    db.execute("""CREATE TABLE stock_prices (stock_id INTEGER,date TEXT,open REAL,high REAL,low REAL,
                 close REAL,adj_close REAL,volume REAL,UNIQUE(stock_id,date))""")
    for sql, params in plan["market_statements"]:
        if "INTO stock_prices" in sql:
            db.execute(sql, params)
    assert db.execute("SELECT COUNT(*),MIN(open),MIN(volume) FROM stock_prices").fetchone() == (100, 10., 1000.)
    with pytest.raises(ValueError, match="full_original_ohlcv_missing"):
        planner.plan_repair(replace(output, canonical_market_daily=[{**p, "volume": None} for p in prices]), inventory, "2026-08-20")
    with pytest.raises(ValueError, match="partial_original_ohlcv"):
        planner.plan_repair(replace(output, canonical_market_daily=prices + [{**prices[0], "stock_id": "101", "volume": None}]), inventory, "2026-08-20")
