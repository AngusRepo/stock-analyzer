from __future__ import annotations

from app.callback_security import (
    normalize_callback_token,
    sanitize_callback_error,
    sanitize_callback_url,
)


def test_callback_token_is_stripped_before_header_construction():
    assert normalize_callback_token(["  secret-token\r\n", "fallback"]) == "secret-token"


def test_callback_error_masks_header_query_and_direct_secret_values():
    secret = "secret-token"
    error = ValueError(
        "Illegal header X-Service-Token: secret-token Authorization=Bearer secret-token "
        "url=https://worker.test/callback?token=secret-token&mode=1"
    )
    text = sanitize_callback_error(error, secret)

    assert secret not in text
    assert "Bearer [REDACTED]" in text or "Authorization=[REDACTED]" in text
    assert "token=[REDACTED]" in text


def test_callback_url_removes_credentials_query_and_fragment():
    assert sanitize_callback_url(
        "https://user:pass@example.test:8443/callback?token=secret#fragment"
    ) == "https://example.test:8443/callback"


def test_callback_error_is_bounded():
    text = sanitize_callback_error("x" * 2_000, max_chars=200)
    assert len(text) == 200
