from __future__ import annotations

from pathlib import Path

from app.universal_training import _controller_callback_token, _ic_summary_value


def test_ic_summary_value_accepts_oos_ic_when_plain_ic_missing():
    assert _ic_summary_value({"oos_ic": 0.123}) == 0.123
    assert _ic_summary_value({"ic_4w_avg": -0.02}) == -0.02


def test_controller_callback_token_prefers_canonical_service_token(monkeypatch):
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "worker-token")
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "controller-secret")
    monkeypatch.setenv("INTERNAL_TOKEN", "internal-token")
    monkeypatch.setenv("ML_CONTROLLER_TOKEN", "service-token")

    assert _controller_callback_token() == "service-token"


def test_retrain_callback_token_prefers_dedicated_token(monkeypatch):
    monkeypatch.setenv("RETRAIN_CALLBACK_TOKEN", "retrain-only-token")
    monkeypatch.setenv("ML_CONTROLLER_TOKEN", "service-token")

    assert _controller_callback_token() == "retrain-only-token"


def test_retrain_callback_token_strips_header_whitespace(monkeypatch):
    monkeypatch.setenv("RETRAIN_CALLBACK_TOKEN", "  retrain-only-token\r\n")

    assert _controller_callback_token() == "retrain-only-token"


def test_modal_retrain_callback_mounts_dedicated_secret():
    modal_source = (Path(__file__).resolve().parents[1] / "modal_app.py").read_text(encoding="utf-8")

    assert 'modal.Secret.from_name("stockvision-retrain-callback")' in modal_source
    assert 'secrets=[gcs_secret, cf_secret, finlab_secret, retrain_callback_secret, runtime_env_secret]' in modal_source
