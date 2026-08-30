from __future__ import annotations

import re
from pathlib import Path


PIPELINE_SOURCE = (
    Path(__file__).resolve().parents[1] / "graphs" / "daily_pipeline_v2.py"
)


def test_async_modal_continuation_persists_pit_shadow_before_export() -> None:
    source = PIPELINE_SOURCE.read_text(encoding="utf-8")
    callback = source.split(
        "async def run_pipeline_v2_from_modal_prediction_callback", 1
    )[1]
    post_prediction_nodes = callback.split(
        "await _run_pipeline_nodes(state, [\n            node_compute_personas,", 1
    )[1].split("])", 1)[0]
    nodes = [
        "node_compute_personas",
        *re.findall(r"\bnode_[a-z0-9_]+", post_prediction_nodes),
    ]

    assert nodes == [
        "node_compute_personas",
        "node_recommend",
        "node_llm_reasons",
        "node_write_d1",
        "node_compute_sector_flow",
        "node_compute_pit_residual_shadow",
        "node_export_dataset_snapshot",
    ]
