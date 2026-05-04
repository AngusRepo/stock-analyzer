from __future__ import annotations

import inspect

from app.dlinear_universal import train_dlinear
from app.patchtst_universal import train_patchtst


def test_sequence_train_functions_accept_model_cpcv_policy_payload():
    dlinear_sig = inspect.signature(train_dlinear)
    patchtst_sig = inspect.signature(train_patchtst)

    assert "model_cpcv_policy" in dlinear_sig.parameters
    assert "model_cpcv_policy" in patchtst_sig.parameters
    assert dlinear_sig.parameters["model_cpcv_policy"].default is None
    assert patchtst_sig.parameters["model_cpcv_policy"].default is None
