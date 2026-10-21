from copy import deepcopy

import numpy as np
import pytest

from services import l3_equal_weight_allocation as bridge
from services.l3_equal_weight import MODELS, fit_calibration
from services import l4_distribution


def fixture():
    rows = [dict(symbol=s, ranks={m: r for m in MODELS}, availability={m: True for m in MODELS},
                 prediction_kind="oof", label_known_date="2026-09-10", gross_return=y)
            for s, r, y in [("A", 0.1, -0.04), ("B", 0.9, 0.04)]]
    calibration = fit_calibration([dict(date="2026-09-01", rows=rows)], source_sha256="a" * 64,
        pool_contract="fixture-L2-v1", signal_date_max="2026-09-01", label_known_at_max="2026-09-10")
    inputs = dict(symbols=["A", "B"], covariance=np.eye(2).tolist(),
        current_weights=[0., 0.], exposure_cap=1., name_cap=0.5, min_weight=0., max_positions=5,
        buy_cost=0.001425, sell_cost=0.004425, risk_aversion=0.01)
    return rows, calibration, inputs


def run(rows, calibration, inputs):
    return bridge.run(rows, calibration=calibration, signal_date="2026-09-11",
                      pool_contract="fixture-L2-v1", allocator_inputs=inputs)


def test_real_optimizer_uses_new_alpha_without_old_model_owners(monkeypatch):
    rows, calibration, inputs = fixture()
    def forbidden(*args, **kwargs):
        raise AssertionError("old L4 model called")
    monkeypatch.setattr(l4_distribution, "predict", forbidden)
    original = deepcopy(inputs)
    out = run(rows, calibration, inputs)
    assert inputs == original
    assert out["weights"]["A"] < 1e-8
    assert out["weights"]["B"] > 0
    assert out["r33_evidence"]["denominator_models"] == 7
    assert out["r33_evidence"]["tabpack_used"] is False
    assert out["expected_trading_cost"] == pytest.approx(inputs["buy_cost"] * out["weights"]["B"])


def test_held_name_outside_rank_pool_is_locked_not_liquidated():
    rows, calibration, inputs = fixture()
    inputs.update(symbols=["A", "B", "HELD"], covariance=np.eye(3).tolist(),
                  current_weights=[0., 0., 0.2], locked_symbols=["HELD"])
    out = run(rows, calibration, inputs)
    assert out["weights"]["HELD"] == pytest.approx(0.2)
    assert out["r33_forecasts"]["HELD"] is None
    del inputs["locked_symbols"]
    with pytest.raises(ValueError, match="cannot_authorize_exit"):
        run(rows, calibration, inputs)


def test_missing_forecast_is_neutral_and_present_in_optimizer():
    rows, calibration, inputs = fixture()
    rows[1]["availability"]["TimeXer"] = False
    rows[1]["ranks"]["TimeXer"] = None
    out = run(rows, calibration, inputs)
    assert out["proof"]["evaluated_candidate_count"] == 2
    assert out["r33_forecasts"]["B"]["effective_ranks"]["TimeXer"] == 0.5
    assert out["r33_forecasts"]["B"]["neutral_rank_contributions"]["TimeXer"] == 0


def test_original_numpy_optimizer_inputs_can_be_sealed_without_mutation():
    rows, calibration, inputs = fixture()
    inputs['covariance'] = np.asarray(inputs['covariance'])
    inputs['current_weights'] = np.asarray(inputs['current_weights'])
    out = run(rows, calibration, inputs)
    assert isinstance(inputs['covariance'], np.ndarray)
    assert len(out['r33_evidence']['allocator_inputs_checksum']) == 64


@pytest.mark.parametrize("bad", ["two_owners", "positions", "missing_holdings", "omit_forecast"])
def test_invalid_contract_never_reaches_optimizer(monkeypatch, bad):
    rows, calibration, inputs = fixture()
    def forbidden(**kwargs):
        raise AssertionError("optimizer must not receive invalid inputs")
    monkeypatch.setattr(bridge, "allocate", forbidden)
    if bad == "two_owners": inputs["expected_gross"] = [0., 0.]
    if bad == "positions": inputs["max_positions"] = 6
    if bad == "missing_holdings": del inputs["current_weights"]
    if bad == "omit_forecast": inputs["symbols"] = ["A"]
    with pytest.raises(ValueError):
        run(rows, calibration, inputs)
