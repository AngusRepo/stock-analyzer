from __future__ import annotations

from typing import Any

from app.dlinear_universal import _build_model

from .sequence_adapter_common import run_torch_window_benchmark


def run_benchmark(payload: dict[str, Any]) -> dict[str, Any]:
    return run_torch_window_benchmark(
        payload,
        candidate_id="DLinear",
        build_model=_build_model,
    )
