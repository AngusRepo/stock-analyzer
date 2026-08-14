"""Small callback-boundary helpers that never expose bearer credentials."""

from __future__ import annotations

import re
from typing import Any, Iterable
from urllib.parse import urlsplit, urlunsplit

_HEADER_SECRET = re.compile(
    r"(?i)(authorization|x-service-token|x-controller-token)(\s*[:=]\s*)(?:bearer\s+)?[^\s,;]+"
)
_BEARER_SECRET = re.compile(r"(?i)\bbearer\s+[^\s,;]+")
_QUERY_SECRET = re.compile(r"(?i)([?&](?:token|key|secret|signature|sig)=)[^&\s]+")


def normalize_callback_token(candidates: Iterable[Any]) -> str:
    for candidate in candidates:
        value = str(candidate or "").strip()
        if value:
            return value
    return ""


def sanitize_callback_url(value: Any) -> str:
    raw = str(value or "").strip()
    if not raw:
        return ""
    try:
        parsed = urlsplit(raw)
        hostname = parsed.hostname or ""
        port = f":{parsed.port}" if parsed.port else ""
        return urlunsplit((parsed.scheme, f"{hostname}{port}", parsed.path, "", ""))
    except (TypeError, ValueError):
        return raw.split("?", 1)[0].split("#", 1)[0]


def sanitize_callback_error(error: Any, *secrets: Any, max_chars: int = 500) -> str:
    if isinstance(error, BaseException):
        text = f"{type(error).__name__}: {error}"
    else:
        text = str(error)
    for secret in secrets:
        value = str(secret or "").strip()
        if value:
            text = text.replace(value, "[REDACTED]")
    text = _HEADER_SECRET.sub(r"\1\2[REDACTED]", text)
    text = _BEARER_SECRET.sub("Bearer [REDACTED]", text)
    text = _QUERY_SECRET.sub(r"\1[REDACTED]", text)
    return text[:max(64, int(max_chars))]
