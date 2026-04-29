from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.cost_tracker import estimate_modal_cost  # noqa: E402


def test_estimate_modal_cost_includes_gpu_cpu_and_memory_components():
    cost = estimate_modal_cost(
        compute_sec=100,
        cpu=2,
        memory_mb=4096,
        gpu="L4",
    )

    expected = 100 * (
        2 * 0.0000131
        + 4 * 0.00000222
        + 0.000222
    )
    assert cost == round(expected, 6)


def test_estimate_modal_cost_ignores_unknown_gpu_but_keeps_cpu_memory():
    cost = estimate_modal_cost(
        compute_sec=10,
        cpu=1,
        memory_mb=1024,
        gpu="unknown",
    )

    assert cost == round(10 * (0.0000131 + 0.00000222), 6)
