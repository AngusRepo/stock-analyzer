from __future__ import annotations

from pathlib import Path


def test_controller_finlab_sdk_pin_tracks_reviewed_latest_version():
    requirements = (
        Path(__file__)
        .resolve()
        .parents[1]
        .joinpath("requirements.txt")
        .read_text(encoding="utf-8", errors="ignore")
    )

    assert "finlab==2.0.13" in requirements
    assert "finlab==2.0.7" not in requirements
