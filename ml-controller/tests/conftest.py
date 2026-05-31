from __future__ import annotations

import os
import uuid
from pathlib import Path

import pytest


@pytest.fixture
def tmp_path() -> Path:
    """Windows/Python 3.14-safe tmp_path for this sandboxed repo."""

    root = Path(__file__).resolve().parents[2] / ".tmp" / "pytest-managed"
    os.makedirs(root, exist_ok=True)
    path = root / f"tmp-{uuid.uuid4().hex}"
    os.makedirs(path)
    return path
