from __future__ import annotations

import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "ml-service"))

import modal_app  # noqa: E402
from app import patchtst_universal  # noqa: E402


def test_modal_patchtst_wrapper_forwards_requested_seed(monkeypatch):
    captured = {}

    def fake_train_patchtst(**kwargs):
        captured.update(kwargs)
        return {
            "metadata": {},
            "ic_tracking": {},
            "version": "research",
            "elapsed_s": 0.1,
            "type": "test",
            "pool_update": None,
            "oof_artifact": None,
            "allowed_use": "research_only",
            "production_effect": False,
            "research_source_bundle_checksum": "a" * 64,
            "metrics": {"oos_ic": 0.01},
        }

    monkeypatch.setattr(modal_app, "_setup_env", lambda: None)
    monkeypatch.setattr(patchtst_universal, "train_patchtst", fake_train_patchtst)

    result = modal_app.train_patchtst_universal.get_raw_f()({"seed": 314})

    assert "error" not in result
    assert captured["seed"] == 314
