import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from graphs.daily_pipeline_v2 import _pipeline_modal_context_overlay_mode  # noqa: E402


@pytest.mark.parametrize("mode", ["blocking", "shadow", "disabled"])
def test_frozen_modal_overlay_context_accepts_canonical_modes(mode: str) -> None:
    assert _pipeline_modal_context_overlay_mode({"state_space_overlay_mode": mode}) == mode


@pytest.mark.parametrize("mode", [None, "", "unexpected"])
def test_frozen_modal_overlay_context_rejects_missing_or_invalid_modes(mode: object) -> None:
    with pytest.raises(
        RuntimeError,
        match="pipeline_modal_serving_context:state_space_overlay_mode_invalid",
    ):
        _pipeline_modal_context_overlay_mode({"state_space_overlay_mode": mode})
