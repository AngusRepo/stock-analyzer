"""MEM-M2 (3): the L3 IC audit filters corporate actions with canonical finlab.price factors."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import audit_l3_production_ic as audit  # noqa: E402


def _price(stock_id, date):
    # Raw legs only: the audit no longer reads legacy stock_prices.adj_close.
    return {"stock_id": stock_id, "price_date": date, "entry_open": 10.0, "entry_date": "2026-05-04",
            "entry_close": 10.0, "exit_date": "2026-05-08", "exit_close": 11.0}


def _canonical(symbol, *, entry_adj=10.0, exit_adj=11.0, exit_close=11.0):
    return [{"symbol": symbol, "date": "2026-05-04", "close": 10.0, "adj_close": entry_adj},
            {"symbol": symbol, "date": "2026-05-08", "close": exit_close, "adj_close": exit_adj}]


def _prediction(stock_id):
    return {"id": stock_id, "stock_id": stock_id, "model_name": "m", "prediction_date": "2026-05-01"}


def test_canonical_factor_filters_corporate_action():
    # Canonical exposes a 2:1 split on the exit leg of 1101; 1102 is factor-stable.
    rows, counts = audit.build_label_rows(
        [_prediction(1), _prediction(2)], [_price(1, "2026-05-01"), _price(2, "2026-05-01")],
        _canonical("1101", exit_adj=5.5) + _canonical("1102"), {1: "1101", 2: "1102"}, "2026-05-10")
    assert [(r["stock_id"], r["label_factor_source"]) for r in rows] == [(2, "canonical")]
    assert rows[0]["actual_return_pct"] == 11.0 / 10.0 - 1.0
    assert counts == {"canonical_close_basis_mismatch_legs": 0, "canonical_factor_missing_predictions": 0}


def test_missing_canonical_is_excluded_not_legacy_filled():
    rows, counts = audit.build_label_rows([_prediction(1)], [_price(1, "2026-05-01")], [], {1: "1101"}, "2026-05-10")
    assert rows == []
    assert counts["canonical_factor_missing_predictions"] == 1


def test_canonical_close_on_other_basis_is_not_used():
    rows, counts = audit.build_label_rows([_prediction(1)], [_price(1, "2026-05-01")],
                                          _canonical("1101", exit_close=22.0, exit_adj=22.0), {1: "1101"}, "2026-05-10")
    assert rows == []
    assert counts == {"canonical_close_basis_mismatch_legs": 1, "canonical_factor_missing_predictions": 1}


def test_immature_exit_is_skipped_not_counted_as_missing_factor():
    # Feed build_label_rows what the production price SQL returns: its window stops at run_date,
    # so a prediction whose 5th trading day is after run_date gets exit_date/exit_close NULL.
    import re
    import sqlite3
    source = (Path(__file__).resolve().parent.parent / "scripts/audit_l3_production_ic.py").read_text()
    price_sql = re.search(r'price_rows = MARKET_D1_CLIENT.query\(\s*"""(.*?)"""', source, re.S).group(1)
    db = sqlite3.connect(":memory:")
    db.row_factory = sqlite3.Row
    db.execute("CREATE TABLE stock_prices(stock_id INT, date TEXT, open REAL, close REAL)")
    days = ["2026-05-01", "2026-05-04", "2026-05-05", "2026-05-06", "2026-05-07", "2026-05-08", "2026-05-11"]
    for day in days:
        db.execute("INSERT INTO stock_prices VALUES (1, ?, 10, 10)", [day])
    run_date = "2026-05-07"
    price_rows = [dict(row) for row in db.execute(price_sql, [run_date, "-35 days", run_date])]
    immature = next(row for row in price_rows if row["price_date"] == "2026-05-01")
    assert immature["exit_date"] is None
    canonical = [{"symbol": "1101", "date": day, "close": 10.0, "adj_close": 10.0} for day in days if day <= run_date]
    predictions = [{**_prediction(1), "prediction_date": day} for day in ("2026-05-01", "2026-05-07")]
    rows, counts = audit.build_label_rows(predictions, price_rows, canonical, {1: "1101"}, run_date)
    assert rows == []
    assert counts == {"canonical_close_basis_mismatch_legs": 0, "canonical_factor_missing_predictions": 0}


def test_one_leg_missing_canonical_is_excluded():
    canonical = [{"symbol": "1101", "date": "2026-05-08", "close": 11.0, "adj_close": 11.0}]
    rows, counts = audit.build_label_rows([_prediction(1)], [_price(1, "2026-05-01")], canonical, {1: "1101"}, "2026-05-10")
    assert rows == []
    assert counts["canonical_factor_missing_predictions"] == 1


def test_script_only_reads():
    source = Path(audit.__file__).read_text(encoding="utf-8")
    assert ".execute(" not in source and ".batch(" not in source
    assert not any(word in source.upper() for word in ("INSERT ", "UPDATE ", "DELETE ", "REPLACE ", "DROP "))


def test_script_never_reads_legacy_adj_close():
    source = Path(audit.__file__).read_text(encoding="utf-8")
    legacy_sql = source[source.index("FROM stock_prices") - 700:source.index("FROM stock_prices")]
    assert "adj_close" not in legacy_sql
