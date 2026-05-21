from __future__ import annotations

from pathlib import Path


def test_modal_app_exposes_breeze2_research_context_function():
    modal_app = Path("ml-service/modal_app.py").read_text(encoding="utf-8")

    assert "def breeze2_research_context(payload: dict) -> dict:" in modal_app
    assert "@app.function" in modal_app
    assert "from app.breeze2_context import build_breeze2_research_context" in modal_app


def test_modal_app_exposes_breeze2_reason_generation_shadow_function():
    modal_app = Path("ml-service/modal_app.py").read_text(encoding="utf-8")

    assert "def breeze2_reason_generation(payload: dict) -> dict:" in modal_app
    assert "gpu=\"L4\"" in modal_app
    assert "from app.breeze2_reason_generation import generate_breeze2_reason_generation" in modal_app
    assert "\"allowed_use\": \"reason_shadow_only\"" in modal_app


def test_controller_modal_client_exposes_breeze2_reason_generation():
    modal_client = Path("ml-controller/services/modal_client.py").read_text(encoding="utf-8")

    assert '"breeze2_reason_generation": {"cpu": 2.0, "memory_mb": 16384, "gpu": "L4"}' in modal_client
    assert "async def _modal_breeze2_reason_generation(payload: dict) -> dict:" in modal_client
    assert "async def breeze2_reason_generation(payload: dict) -> dict:" in modal_client
    assert 'source="modal_breeze2_reason_generation"' in modal_client
