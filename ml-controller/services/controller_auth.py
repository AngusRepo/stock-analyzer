"""Central deny-by-default authentication policy for ml-controller."""
from __future__ import annotations

import hmac
import os
from dataclasses import dataclass

from fastapi import HTTPException, Request
from starlette.responses import JSONResponse, Response


PUBLIC_PATHS = frozenset({"/health"})


@dataclass(frozen=True)
class ControllerAuthDecision:
    allowed: bool
    status_code: int = 200
    code: str = "ok"


def _is_cloud_runtime() -> bool:
    return bool(os.environ.get("K_SERVICE", "").strip() or os.environ.get("K_REVISION", "").strip())


def _explicit_local_bypass() -> bool:
    environment = os.environ.get("ENVIRONMENT", "").strip().lower()
    return (
        environment in {"development", "local", "test"}
        and os.environ.get("ALLOW_INSECURE_LOCAL_AUTH", "").strip() == "1"
        and not _is_cloud_runtime()
    )


def evaluate_controller_auth(token: str) -> ControllerAuthDecision:
    expected = os.environ.get("ML_CONTROLLER_SECRET", "").strip()
    if not expected:
        if _explicit_local_bypass():
            return ControllerAuthDecision(True, code="explicit_local_bypass")
        return ControllerAuthDecision(False, 503, "controller_auth_not_configured")
    if not token or not hmac.compare_digest(token, expected):
        return ControllerAuthDecision(False, 401, "invalid_controller_token")
    return ControllerAuthDecision(True)


async def verify_controller_token(request: Request) -> None:
    enforce_controller_token(request)


def enforce_controller_token(request: Request) -> None:
    """Apply the canonical controller-token decision to any HTTP entrypoint."""
    decision = evaluate_controller_auth(request.headers.get("X-Controller-Token", "").strip())
    if not decision.allowed:
        raise HTTPException(status_code=decision.status_code, detail=decision.code)


async def controller_auth_middleware(request: Request, call_next) -> Response:
    """Deny by default for every current and future controller route."""
    if request.method == "OPTIONS" or request.url.path in PUBLIC_PATHS:
        return await call_next(request)
    decision = evaluate_controller_auth(request.headers.get("X-Controller-Token", "").strip())
    if not decision.allowed:
        return JSONResponse(
            status_code=decision.status_code,
            content={
                "ok": False,
                "error": {
                    "code": decision.code,
                    "message": "Controller authentication failed",
                },
            },
        )
    return await call_next(request)
