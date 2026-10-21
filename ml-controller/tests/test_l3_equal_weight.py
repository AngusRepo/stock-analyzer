from copy import deepcopy

import numpy as np
import pytest

from services import l3_equal_weight as eq
from services.l4_distribution import digest


def row(symbol, rank):
    return dict(symbol=symbol, ranks={m: rank for m in eq.MODELS},
                availability={m: True for m in eq.MODELS})


def days():
    result = []
    for day in ("2026-09-01", "2026-09-02"):
        rows = [row("1101", 0.1), row("2330", 0.9)]
        for r, y in zip(rows, (-0.04, 0.04)):
            r.update(gross_return=y, label_known_date="2026-09-10", prediction_kind="oof")
        result.append(dict(date=day, rows=rows))
    return result


def calibration(source=None):
    return eq.fit_calibration(source or days(), source_sha256="a" * 64, pool_contract="fixture-L2-pool-v1",
                              signal_date_max="2026-09-02", label_known_at_max="2026-09-10")


def test_missing_rank_is_neutral_fixed_denominator_and_stock_preserved():
    rows = [row("1101", 0.9), row("2330", 0.1)]
    rows[0]["availability"]["TimeXer"] = False
    rows[0]["ranks"]["TimeXer"] = None
    result = eq.combine(rows)
    assert [r["symbol"] for r in result] == ["1101", "2330"]
    assert result[0]["rank_score"] == pytest.approx((6 * 0.9 + 0.5) / 7)
    assert result[0]["rank_score"] != pytest.approx(0.9)
    assert result[0]["neutral_rank_contributions"]["TimeXer"] == 0
    assert result[0]["missing_models"] == ["TimeXer"]


def test_xgboost_never_contributes():
    rows = [row("1101", 0.9), row("2330", 0.1)]
    expected = eq.combine(rows)
    rows[0]["ranks"]["XGBoost"] = 0.0
    rows[1]["ranks"]["XGBoost"] = 1.0
    assert eq.combine(rows) == expected


def test_available_bad_rank_is_integrity_error_not_implicit_missing():
    rows = [row("1101", 0.9), row("2330", 0.1)]
    rows[0]["ranks"]["GNN"] = float("nan")
    with pytest.raises(ValueError, match="available_rank_invalid"):
        eq.combine(rows)


def test_missing_availability_attestation_is_not_guessed():
    rows = [row("1101", 0.9), row("2330", 0.1)]
    del rows[0]["availability"]["GNN"]
    with pytest.raises(ValueError, match="availability_not_attested"):
        eq.combine(rows)


def test_all_missing_stock_remains_neutral_in_nonconstant_pool():
    rows = [row("1101", 0.9), row("2330", 0.1), row("9999", 1.0)]
    rows[2]["availability"] = {m: False for m in eq.MODELS}
    result = eq.combine(rows)
    assert result[2]["rank_score"] == 0.5
    assert result[2]["z"] == pytest.approx(0)
    assert set(result[2]["neutral_rank_contributions"].values()) == {0.0}


def test_calibration_preserves_units_and_frozen_pool_identity():
    frozen = calibration()
    assert frozen["linear_b"] == pytest.approx(0.1)
    result = eq.calibrated_scores(days()[0]["rows"], calibration=frozen,
        signal_date="2026-09-11", pool_contract="fixture-L2-pool-v1")
    assert np.allclose([r["expected_return"] for r in result], [-0.04, 0.04])
    assert all(r["output_is_net_of_costs"] is False for r in result)
    with pytest.raises(ValueError, match="identity_mismatch"):
        eq.calibrated_scores(days()[0]["rows"], calibration=frozen,
            signal_date="2026-09-11", pool_contract="different-pool")


@pytest.mark.parametrize("change", ["source_checksum", "not_oof", "future_label", "same_day_signal", "negative_slope", "wrong_units"])
def test_calibration_rejects_broken_source_time_or_direction(change):
    frozen = calibration()
    if change == "not_oof":
        source = deepcopy(days()); source[0]["rows"][0]["prediction_kind"] = "final_fit"
        with pytest.raises(ValueError, match="requires_cutoff_oof"):
            calibration(source)
        return
    if change == "future_label":
        source = deepcopy(days()); source[0]["rows"][0]["label_known_date"] = "2026-09-11"
        with pytest.raises(ValueError, match="requires_cutoff_oof"):
            calibration(source)
        return
    if change == "source_checksum":
        frozen["linear_b"] *= 2
    if change == "negative_slope":
        frozen["linear_b"] = -0.1
        frozen["checksum"] = digest({k: v for k, v in frozen.items() if k != "checksum"})
    if change == "wrong_units":
        frozen["expected_return_semantic"] = "daily_percentage_points"
        frozen["checksum"] = digest({k: v for k, v in frozen.items() if k != "checksum"})
    with pytest.raises(ValueError):
        eq.calibrated_scores(days()[0]["rows"], calibration=frozen,
            signal_date="2026-09-10" if change == "same_day_signal" else "2026-09-11",
            pool_contract="fixture-L2-pool-v1")
