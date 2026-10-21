"""R33 forecast -> existing optimizer boundary; no account or publication IO.

Canonical account/risk producers supply the original optimizer inputs. This
adapter owns only expected returns and never runs L4 heads, TabPack or P3.
"""
from __future__ import annotations

from copy import deepcopy

import numpy as np

from services.l3_equal_weight import MODELS, RECIPE, calibrated_scores
from services.l4_distribution import digest
from services.l4_portfolio import allocate


def _evidence_value(value):
    if isinstance(value, np.ndarray):
        return value.tolist()
    if isinstance(value, np.generic):
        return value.item()
    if isinstance(value, dict):
        return {key: _evidence_value(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_evidence_value(item) for item in value]
    if isinstance(value, (set, frozenset)):
        return sorted(_evidence_value(item) for item in value)
    return value


def run(rank_pool, *, calibration, signal_date, pool_contract, allocator_inputs):
    inputs = deepcopy(allocator_inputs)
    if "expected_gross" in inputs:
        raise ValueError("r33_multiple_expected_return_owners")
    cap = inputs.get("max_positions")
    if type(cap) is not int or not 1 <= cap <= 5:
        raise ValueError("r33_maximum_five_positions_required")
    symbols = inputs.get("symbols") or []
    if not symbols or len(set(symbols)) != len(symbols):
        raise ValueError("r33_allocator_symbols_invalid")
    scores = calibrated_scores(rank_pool, calibration=calibration,
                               signal_date=signal_date, pool_contract=pool_contract)
    forecasts = {row["symbol"]: row for row in scores}
    if set(forecasts) - set(symbols):
        raise ValueError("r33_allocator_omits_forecast_stock")
    outside_pool = set(symbols) - set(forecasts)
    locked = set(inputs.get("locked_symbols") or [])
    if outside_pool - locked:
        raise ValueError("r33_missing_forecast_cannot_authorize_exit")
    # Zero utility on a fixed/locked variable is inert, never a sale instruction.
    expected = [forecasts[s]["expected_return"] if s in forecasts else 0. for s in symbols]
    current = np.asarray(inputs.get("current_weights"), dtype=float)
    if current.shape != (len(symbols),):
        raise ValueError("r33_current_holdings_missing")
    result = allocate(expected_gross=expected, **inputs)
    evidence = dict(schema_version="r33-equal7-allocation-boundary-v1", recipe=RECIPE,
        signal_date=signal_date, pool_contract=pool_contract, model_order=list(MODELS),
        missing_rank=0.5, denominator_models=7, calibration_checksum=calibration["checksum"],
        expected_return_semantic="five_session_relative_pool_decimal",
        output_is_net_of_costs=False, cost_owner="l4_portfolio.allocate",
        forecasts_checksum=digest(scores), allocator_inputs_checksum=digest(_evidence_value(inputs)),
        current_holdings_supplied=True, locked_unmodeled_symbols=sorted(outside_pool),
        allocator_owner="l4_portfolio.allocate", l4_heads_used=False, tabpack_used=False,
        fitted_stacker_used=False, preselection=False)
    evidence["checksum"] = digest(evidence)
    return {**result, "r33_evidence": evidence,
            "r33_forecasts": {s: forecasts.get(s) for s in symbols}}
