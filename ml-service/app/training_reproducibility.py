"""Deterministic runtime setup shared by formal ML trainers."""

from __future__ import annotations

import os
import random
from typing import Any

import numpy as np


def configure_training_reproducibility(seed: int | str | None = 42) -> dict[str, Any]:
    """Seed every available RNG before model construction.

    Torch is optional so CPU-only tree/model-policy tests do not acquire a hard
    dependency. Deterministic algorithms are warn-only because a future library
    kernel must not silently switch the formal configuration; the returned
    receipt is embedded in the artifact attestation.
    """

    resolved_seed = int(seed if seed is not None else 42)
    os.environ["PYTHONHASHSEED"] = str(resolved_seed)
    os.environ["CUBLAS_WORKSPACE_CONFIG"] = ":4096:8"
    random.seed(resolved_seed)
    np.random.seed(resolved_seed)

    receipt: dict[str, Any] = {
        "seed": resolved_seed,
        "python_random": True,
        "numpy_random": True,
        "torch_available": False,
        "torch_deterministic_algorithms": None,
        "torch_deterministic_warn_only": None,
        "cudnn_deterministic": None,
        "cudnn_benchmark": None,
        "cublas_workspace_config": os.environ.get("CUBLAS_WORKSPACE_CONFIG"),
    }
    try:
        import torch

        torch.manual_seed(resolved_seed)
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(resolved_seed)
        torch.use_deterministic_algorithms(True, warn_only=True)
        if hasattr(torch.backends, "cudnn"):
            torch.backends.cudnn.deterministic = True
            torch.backends.cudnn.benchmark = False
        receipt.update({
            "torch_available": True,
            "torch_deterministic_algorithms": True,
            "torch_deterministic_warn_only": True,
            "cudnn_deterministic": bool(getattr(torch.backends.cudnn, "deterministic", False)),
            "cudnn_benchmark": bool(getattr(torch.backends.cudnn, "benchmark", False)),
        })
    except ImportError:
        pass
    return receipt
