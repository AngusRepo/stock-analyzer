from __future__ import annotations

import pytest

from app.callback_policy import CallbackPolicyError, resolve_callback_target


def _clear(monkeypatch):
    for name in (
        "ML_CONTROLLER_PUBLIC_URL",
        "ML_CONTROLLER_URL",
        "ML_CONTROLLER_SECRET",
        "ML_CONTROLLER_TOKEN",
        "INTERNAL_TOKEN",
        "STOCKVISION_WORKER_URL",
        "STOCKVISION_AUTH_TOKEN",
        "ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)


def test_pipeline_target_is_derived_from_server_configuration(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ML_CONTROLLER_PUBLIC_URL", "https://controller.example.test")
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "controller-secret")
    target = resolve_callback_target("pipeline_prediction")
    assert target.url == "https://controller.example.test/pipeline/v2/modal-prediction/callback"
    assert target.headers["X-Controller-Token"] == "controller-secret"
    assert "Authorization" not in target.headers


def test_payload_cannot_change_registered_destination(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example.test")
    monkeypatch.setenv("STOCKVISION_AUTH_TOKEN", "worker-secret")
    with pytest.raises(CallbackPolicyError, match="does not match registered target"):
        resolve_callback_target(
            "state_space_shadow",
            supplied_url="http://169.254.169.254/computeMetadata/v1/",
        )


def test_redirect_style_path_or_query_cannot_be_injected(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ML_CONTROLLER_PUBLIC_URL", "https://controller.example.test?next=http://127.0.0.1")
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "controller-secret")
    with pytest.raises(CallbackPolicyError, match="query or fragment"):
        resolve_callback_target("retrain_followup")


def test_missing_server_credential_fails_closed(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("STOCKVISION_WORKER_URL", "https://worker.example.test")
    with pytest.raises(CallbackPolicyError, match="credential is not configured"):
        resolve_callback_target("finlab_worker")


def test_http_is_limited_to_explicit_loopback_development(monkeypatch):
    _clear(monkeypatch)
    monkeypatch.setenv("ML_CONTROLLER_URL", "http://localhost:8080")
    monkeypatch.setenv("ML_CONTROLLER_SECRET", "controller-secret")
    with pytest.raises(CallbackPolicyError, match="must use HTTPS"):
        resolve_callback_target("pipeline_prediction")
    monkeypatch.setenv("ENVIRONMENT", "test")
    assert resolve_callback_target("pipeline_prediction").url.startswith("http://localhost:8080/")
