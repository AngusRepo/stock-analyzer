from __future__ import annotations

from typing import Any

from .neuralforecast_sequence_adapter import run_neuralforecast_benchmark


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    return run_neuralforecast_benchmark(
        payload,
        candidate_id="iTransformer",
        model_name="iTransformer",
    )
