"""Service token for controller -> ml-service (Modal fastapi_app) HTTP calls.

ml-service rejects every route but /health without `X-Service-Token`. In production a
missing ML_SERVICE_SECRET is a configuration error: fail before the request, not with a
401 from the far side. Outside production the header is omitted (local ml-service dev).
"""
from __future__ import annotations

import os

SERVICE_TOKEN_ENV = "ML_SERVICE_SECRET"
SERVICE_TOKEN_HEADER = "X-Service-Token"


class MlServiceTokenMissing(RuntimeError):
    """ML_SERVICE_SECRET is not configured in production."""


def ml_service_headers(base: dict[str, str] | None = None) -> dict[str, str]:
    headers = {"Content-Type": "application/json", **(base or {})}
    token = os.environ.get(SERVICE_TOKEN_ENV, "").strip()
    if token:
        headers[SERVICE_TOKEN_HEADER] = token
    elif os.environ.get("ENVIRONMENT", "development").strip().lower() == "production":
        raise MlServiceTokenMissing(f"{SERVICE_TOKEN_ENV} not configured; ml-service calls require {SERVICE_TOKEN_HEADER}")
    return headers
