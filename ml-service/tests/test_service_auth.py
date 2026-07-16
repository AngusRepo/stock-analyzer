from __future__ import annotations

from app.service_auth import evaluate_service_auth


def _clear_runtime(monkeypatch):
    for name in (
        "ML_SERVICE_SECRET",
        "ENVIRONMENT",
        "ALLOW_INSECURE_LOCAL_AUTH",
        "K_SERVICE",
        "K_REVISION",
        "MODAL_TASK_ID",
        "MODAL_ENVIRONMENT",
    ):
        monkeypatch.delenv(name, raising=False)


def test_missing_secret_fails_closed(monkeypatch):
    _clear_runtime(monkeypatch)
    decision = evaluate_service_auth("")
    assert decision.allowed is False
    assert decision.status_code == 503
    assert decision.code == "service_auth_not_configured"


def test_invalid_token_is_rejected_and_valid_token_is_accepted(monkeypatch):
    _clear_runtime(monkeypatch)
    monkeypatch.setenv("ML_SERVICE_SECRET", "expected-token")
    assert evaluate_service_auth("wrong-token").status_code == 401
    assert evaluate_service_auth("expected-token").allowed is True


def test_local_bypass_requires_explicit_double_opt_in(monkeypatch):
    _clear_runtime(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "development")
    assert evaluate_service_auth("").allowed is False
    monkeypatch.setenv("ALLOW_INSECURE_LOCAL_AUTH", "1")
    decision = evaluate_service_auth("")
    assert decision.allowed is True
    assert decision.code == "explicit_local_bypass"


def test_cloud_runtime_cannot_use_local_bypass(monkeypatch):
    _clear_runtime(monkeypatch)
    monkeypatch.setenv("ENVIRONMENT", "development")
    monkeypatch.setenv("ALLOW_INSECURE_LOCAL_AUTH", "1")
    monkeypatch.setenv("K_SERVICE", "stockvision-ml")
    assert evaluate_service_auth("").allowed is False
