from __future__ import annotations

from app.callback_policy import resolve_callback_target
from app.universal_training import _ic_summary_value


def test_ic_summary_value_accepts_oos_ic_when_plain_ic_missing():
    assert _ic_summary_value({"oos_ic": 0.123}) == 0.123
    assert _ic_summary_value({"ic_4w_avg": -0.02}) == -0.02


def test_retrain_callback_uses_server_owned_controller_secret(monkeypatch):
    monkeypatch.setenv("ML_CONTROLLER_PUBLIC_URL", "https://controller.example.test")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "worker-token")
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "controller-secret")
    monkeypatch.setenv("INTERNAL_TOKEN", "internal-token")
    monkeypatch.setenv("ML_CONTROLLER_TOKEN", "service-token")

    target = resolve_callback_target("retrain_followup")
    assert target.url.endswith("/retrain/followup")
    assert target.headers["X-Controller-Token"] == "controller-secret"
