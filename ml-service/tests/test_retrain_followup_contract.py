from __future__ import annotations

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
