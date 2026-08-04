from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from typing import Any


FINLAB_SESSION_ENV_NAMES = (
    "FINLAB_API_KEY",
    "FINLAB_REFRESH_TOKEN",
    "FINLAB_SESSION_ID",
)
FINLAB_SESSION_ONLY_ENV_NAMES = (
    "FINLAB_REFRESH_TOKEN",
    "FINLAB_SESSION_ID",
)


def finlab_session_auth_available(env: Mapping[str, str] | None = None) -> bool:
    source = os.environ if env is None else env
    return all(str(source.get(name) or "").strip() for name in FINLAB_SESSION_ENV_NAMES)


def login_finlab_sdk(
    login: Callable[..., Any],
    *,
    legacy_api_key: str | None = None,
    env: Mapping[str, str] | None = None,
) -> str:
    """Use FinLab 2.x headless session auth with a legacy-only fallback.

    The refresh-token/session-id pair is fail-closed: when either is present,
    all three session variables must exist. This prevents a Firebase API key
    from being misinterpreted as the deprecated legacy API token.
    """

    source = os.environ if env is None else env
    if finlab_session_auth_available(source):
        login()
        return "session"

    has_session_marker = any(
        str(source.get(name) or "").strip() for name in FINLAB_SESSION_ONLY_ENV_NAMES
    )
    if has_session_marker:
        missing = [
            name
            for name in FINLAB_SESSION_ENV_NAMES
            if not str(source.get(name) or "").strip()
        ]
        raise RuntimeError(f"finlab_session_auth_incomplete:{','.join(missing)}")

    api_key = str(legacy_api_key or source.get("FINLAB_API_KEY") or "").strip()
    if not api_key:
        raise RuntimeError("finlab_auth_missing")

    login(api_key)
    return "legacy_api_token"
