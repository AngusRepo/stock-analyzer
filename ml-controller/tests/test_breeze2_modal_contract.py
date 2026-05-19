from __future__ import annotations

from pathlib import Path


def test_modal_app_exposes_breeze2_research_context_function():
    modal_app = Path("ml-service/modal_app.py").read_text(encoding="utf-8")

    assert "def breeze2_research_context(payload: dict) -> dict:" in modal_app
    assert "@app.function" in modal_app
    assert "from app.breeze2_context import build_breeze2_research_context" in modal_app
