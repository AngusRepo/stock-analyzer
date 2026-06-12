"""NeuralForecast-backed iTransformer batch serving for L3 sequence family."""

from __future__ import annotations

from .neuralforecast_sequence_runtime import (
    DEFAULT_PRED_LEN,
    DEFAULT_SEQ_LEN,
    MODEL_CONFIG,
    neuralforecast_batch_predict,
)

MODEL_NAME = "iTransformer"
GCS_WEIGHTS_PREFIX = MODEL_CONFIG[MODEL_NAME]["gcs_prefix"]
DEFAULT_D_MODEL = 0
DEFAULT_N_HEADS = 0
DEFAULT_N_LAYERS = 0
DEFAULT_DROPOUT = 0.0


def itransformer_batch_predict(
    series_list: list[dict],
    horizon_used: int = DEFAULT_PRED_LEN,
    version: str = "v1",
) -> list[dict]:
    return neuralforecast_batch_predict(
        model_name=MODEL_NAME,
        series_list=series_list,
        horizon_used=horizon_used,
        version=version,
    )
