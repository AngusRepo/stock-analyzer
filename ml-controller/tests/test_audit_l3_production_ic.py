"""MEM-M2 (3): the L3 IC audit filters corporate actions with canonical finlab.price factors."""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from scripts import audit_l3_production_ic as audit  # noqa: E402


def _price(stock_id, date, *, entry_adj=10.0, exit_adj=11.0):
    return {"stock_id": stock_id, "price_date": date, "entry_open": 10.0, "entry_date": "2026-05-04",
            "entry_close": 10.0, "entry_adj_close": entry_adj, "exit_date": "2026-05-08",
            "exit_close": 11.0, "exit_adj_close": exit_adj}


def _canonical(symbol, *, entry_adj=10.0, exit_adj=11.0, exit_close=11.0):
    return [{"symbol": symbol, "date": "2026-05-04", "close": 10.0, "adj_close": entry_adj},
            {"symbol": symbol, "date": "2026-05-08", "close": exit_close, "adj_close": exit_adj}]


def _prediction(stock_id):
    return {"id": stock_id, "stock_id": stock_id, "model_name": "m", "prediction_date": "2026-05-01"}


def test_canonical_factor_overrides_legacy_raw_close_substitute():
    # Legacy adj_close=close on the exit leg hides a 2:1 split; canonical exposes it.
    rows, skipped = audit.build_label_rows(
        [_prediction(1), _prediction(2)], [_price(1, "2026-05-01"), _price(2, "2026-05-01")],
        _canonical("1101", exit_adj=5.5) + _canonical("1102"), {1: "1101", 2: "1102"}, "2026-05-10")
    assert [(r["stock_id"], r["label_factor_source"]) for r in rows] == [(2, "canonical")]
    assert skipped == {"canonical_close_basis_mismatch_legs": 0}


def test_missing_canonical_falls_back_to_legacy_and_is_marked():
    rows, _ = audit.build_label_rows([_prediction(1)], [_price(1, "2026-05-01")], [], {1: "1101"}, "2026-05-10")
    assert rows[0]["label_factor_source"] == "legacy_only"
    assert rows[0]["actual_return_pct"] == 11.0 / 10.0 - 1.0


def test_canonical_close_on_other_basis_is_not_used():
    rows, skipped = audit.build_label_rows([_prediction(1)], [_price(1, "2026-05-01")],
                                           _canonical("1101", exit_close=22.0, exit_adj=22.0), {1: "1101"}, "2026-05-10")
    assert rows[0]["label_factor_source"] == "legacy_only"
    assert skipped == {"canonical_close_basis_mismatch_legs": 1}


def test_script_only_reads():
    source = Path(audit.__file__).read_text(encoding="utf-8")
    assert ".execute(" not in source and ".batch(" not in source
    assert not any(word in source.upper() for word in ("INSERT ", "UPDATE ", "DELETE ", "REPLACE ", "DROP "))


def test_one_leg_missing_canonical_uses_legacy_for_both_legs():
    # Legacy raw-close substitute on entry (factor 1) and canonical post-split exit (factor 1)
    # would hide the split if mixed; legacy-only on both legs exposes it (exit legacy factor 0.5).
    price = _price(1, "2026-05-01", exit_adj=5.5)
    canonical = [{"symbol": "1101", "date": "2026-05-08", "close": 11.0, "adj_close": 11.0}]
    rows, _ = audit.build_label_rows([_prediction(1)], [price], canonical, {1: "1101"}, "2026-05-10")
    assert rows == []
