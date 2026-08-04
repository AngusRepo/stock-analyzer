from __future__ import annotations

import sys
from pathlib import Path

import pytest


sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.finlab_auth import login_finlab_sdk  # noqa: E402


def test_finlab_session_auth_uses_no_argument_login() -> None:
    calls: list[tuple[object, ...]] = []
    env = {
        "FINLAB_API_KEY": "firebase-api-key",
        "FINLAB_REFRESH_TOKEN": "refresh-token",
        "FINLAB_SESSION_ID": "session-id",
    }

    mode = login_finlab_sdk(lambda *args: calls.append(args), env=env)

    assert mode == "session"
    assert calls == [()]


def test_finlab_legacy_auth_remains_a_bounded_fallback() -> None:
    calls: list[tuple[object, ...]] = []

    mode = login_finlab_sdk(
        lambda *args: calls.append(args),
        legacy_api_key="legacy-token",
        env={},
    )

    assert mode == "legacy_api_token"
    assert calls == [("legacy-token",)]


def test_finlab_partial_session_auth_fails_closed() -> None:
    with pytest.raises(RuntimeError, match="finlab_session_auth_incomplete:FINLAB_SESSION_ID"):
        login_finlab_sdk(
            lambda *_args: None,
            env={
                "FINLAB_API_KEY": "firebase-api-key",
                "FINLAB_REFRESH_TOKEN": "refresh-token",
            },
        )
