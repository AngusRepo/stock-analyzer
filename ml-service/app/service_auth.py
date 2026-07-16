"""Central authentication policy for the ML service.

All non-public HTTP routes are protected here so newly registered routers cannot
bypass authentication because an endpoint forgot an inline check.
"""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse, Response


PUBLIC_PATHS = frozenset({"/health"})
LOCAL_ENVIRONMENTS = frozenset({"development", "local", "test"})


@dataclass(frozen=True)
class ServiceAuthDecision:
    allowed: bool
    status_code: int = 200
    code: str = "ok"


def _is_cloud_runtime() -> bool:
    return any(
        os.environ.get(name, "").strip()
        for name in ("K_SERVICE", "K_REVISION", "MODAL_TASK_ID", "MODAL_ENVIRONMENT")
    )


def _allow_explicit_local_bypass() -> bool:
    environment = os.environ.get("ENVIRONMENT", "").strip().lower()
    return (
        environment in LOCAL_ENVIRONMENTS
        and os.environ.get("ALLOW_INSECURE_LOCAL_AUTH", "").strip() == "1"
        and not _is_cloud_runtime()
    )


def evaluate_service_auth(token: str) -> ServiceAuthDecision:
    """Evaluate the service token without raising or leaking configuration."""
    expected = os.environ.get("ML_SERVICE_SECRET", "").strip()
    if not expected:
        if _allow_explicit_local_bypass():
            return ServiceAuthDecision(allowed=True, code="explicit_local_bypass")
        return ServiceAuthDecision(
            allowed=False,
            status_code=503,
            code="service_auth_not_configured",
        )
    if not token or not hmac.compare_digest(token, expected):
        return ServiceAuthDecision(
            allowed=False,
            status_code=401,
            code="invalid_service_token",
        )
    return ServiceAuthDecision(allowed=True)


def _request_token(request: Request) -> str:
    return request.headers.get("X-Service-Token", "").strip()


async def verify_service_token(request: Request) -> None:
    """FastAPI dependency/inline compatibility entrypoint."""
    decision = evaluate_service_auth(_request_token(request))
    if not decision.allowed:
        raise HTTPException(status_code=decision.status_code, detail=decision.code)


async def service_auth_middleware(request: Request, call_next) -> Response:
    """Deny-by-default auth boundary for every current and future route."""
    if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
        return await call_next(request)

    decision = evaluate_service_auth(_request_token(request))
    if not decision.allowed:
        return JSONResponse(
            status_code=decision.status_code,
            content={
                "ok": False,
                "error": {
                    "code": decision.code,
                    "message": "ML service authentication failed",
                },
            },
        )
    return await call_next(request)
