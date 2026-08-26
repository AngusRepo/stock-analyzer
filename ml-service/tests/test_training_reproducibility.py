from __future__ import annotations

import random
import sys
from pathlib import Path

import numpy as np


sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from app.training_reproducibility import configure_training_reproducibility  # noqa: E402


def test_training_seed_replays_python_numpy_and_records_runtime_contract():
    first_receipt = configure_training_reproducibility(314)
    first_python = random.random()
    first_numpy = float(np.random.random())

    second_receipt = configure_training_reproducibility(314)
    second_python = random.random()
    second_numpy = float(np.random.random())

    assert first_python == second_python
    assert first_numpy == second_numpy
    assert first_receipt["seed"] == 314
    assert second_receipt["cublas_workspace_config"] == ":4096:8"
    if second_receipt["torch_available"]:
        assert second_receipt["torch_deterministic_algorithms"] is True
        assert second_receipt["torch_deterministic_warn_only"] is True
        assert second_receipt["cudnn_benchmark"] is False
