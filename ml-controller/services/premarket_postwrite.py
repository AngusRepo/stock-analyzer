"""Resume next-session research after the morning serving callback.

The premarket phase receipts keep this work on the same sealed L3 and morning
context. Replaying the detached job skips every completed research phase.
"""
from __future__ import annotations


async def run_premarket_postwrite(input_uri: str) -> None:
    from graphs.daily_pipeline_v2 import (
        _merge_pipeline_state_update,
        node_compute_pit_residual_shadow,
        node_compute_sector_flow,
    )
    from services.premarket_pipeline import resume

    await resume(
        input_uri,
        nodes=[node_compute_sector_flow, node_compute_pit_residual_shadow],
        merge=_merge_pipeline_state_update,
        postwrite_only=True,
    )
