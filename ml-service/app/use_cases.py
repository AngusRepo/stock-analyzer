"""
Stable ML service use-case surface.

Keep Modal and other runtime callers from importing the FastAPI route module
directly. The concrete implementations still live in ``main.py`` for now, so
later extractions can move the bodies behind this boundary without changing
external call sites.
"""

from .schemas import PredictRequest
from .prediction_runtime import (
    ARFUpdateRequest,
    predict_stock,
    predict_stock_v2,
    retrain_stock,
    update_arf,
)
from .universal_training import (
    UniversalPrepRequest,
    UniversalTrainRequest,
    prep_universal_batch,
    run_shap_audit,
    train_universal_from_gcs,
)

__all__ = [
    "ARFUpdateRequest",
    "PredictRequest",
    "UniversalPrepRequest",
    "UniversalTrainRequest",
    "predict_stock",
    "predict_stock_v2",
    "prep_universal_batch",
    "retrain_stock",
    "run_shap_audit",
    "train_universal_from_gcs",
    "update_arf",
]
