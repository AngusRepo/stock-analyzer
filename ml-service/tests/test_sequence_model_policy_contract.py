from __future__ import annotations

import inspect

from app.dlinear_universal import _sequence_input_series_count as dlinear_input_series_count
from app.dlinear_universal import train_dlinear
from app.patchtst_universal import _sequence_input_series_count as patchtst_input_series_count
from app.patchtst_universal import train_patchtst


def test_sequence_train_functions_accept_model_cpcv_policy_payload():
    dlinear_sig = inspect.signature(train_dlinear)
    patchtst_sig = inspect.signature(train_patchtst)

    assert "model_cpcv_policy" in dlinear_sig.parameters
    assert "model_cpcv_policy" in patchtst_sig.parameters
    assert dlinear_sig.parameters["model_cpcv_policy"].default is None
    assert patchtst_sig.parameters["model_cpcv_policy"].default is None


def test_sequence_metadata_prefers_sequence_report_coverage_without_torch():
    sequence_report = {"input_series": 3, "train_windows": 63, "oos_windows": 21}

    assert dlinear_input_series_count([], sequence_report) == 3
    assert patchtst_input_series_count([], sequence_report) == 3


def test_sequence_metadata_falls_back_to_series_close_for_legacy_input():
    series_close = [[1, 2, 3], [2, 3, 4]]

    assert dlinear_input_series_count(series_close, {"input_series": 0}) == 2
    assert patchtst_input_series_count(series_close, None) == 2
