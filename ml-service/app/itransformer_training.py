"""Artifact-only NeuralForecast iTransformer training."""

from __future__ import annotations

from typing import Any

from .neuralforecast_sequence_runtime import train_neuralforecast_sequence_artifact

MODEL_NAME = "iTransformer"


def train_itransformer_universal(payload: dict | None = None) -> dict[str, Any]:
    """Train and persist one candidate artifact; serving changes require D1 pointer promotion."""

    result = train_neuralforecast_sequence_artifact(dict(payload or {}), model_name=MODEL_NAME)
    model_cpcv = (
        result.get("model_cpcv")
        or (result.get("metadata") or {}).get("model_cpcv")
        or (result.get("metrics") or {}).get("model_cpcv")
    )
    return {**result, "model_cpcv": model_cpcv, "production_effect": False}
