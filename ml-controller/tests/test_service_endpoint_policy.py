from __future__ import annotations

import pytest

from services.service_endpoint_policy import (
    ServiceEndpointPolicyError,
    service_url,
    validate_discord_webhook_url,
    validate_service_base_url,
)


def test_metadata_and_private_targets_are_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    for target in ("http://169.254.169.254", "https://metadata.google.internal", "https://127.0.0.1"):
        with pytest.raises(ServiceEndpointPolicyError):
            validate_service_base_url(target, name="TEST_URL")


def test_public_https_service_path_is_server_owned(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "production")
    assert service_url("https://worker.example", "/api/admin/callback", name="WORKER") == (
        "https://worker.example/api/admin/callback"
    )
    with pytest.raises(ServiceEndpointPolicyError):
        service_url("https://worker.example", "/../metadata", name="WORKER")


def test_loopback_requires_explicit_non_cloud_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.delenv("K_SERVICE", raising=False)
    assert validate_service_base_url("http://127.0.0.1:8787", name="LOCAL") == "http://127.0.0.1:8787"


def test_discord_webhook_is_origin_and_path_allowlisted() -> None:
    assert validate_discord_webhook_url("https://discord.com/api/webhooks/1/token")
    with pytest.raises(ServiceEndpointPolicyError):
        validate_discord_webhook_url("http://169.254.169.254/latest/meta-data")
    with pytest.raises(ServiceEndpointPolicyError):
        validate_discord_webhook_url("https://example.com/api/webhooks/1/token")
