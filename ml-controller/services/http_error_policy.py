"""Uniform HTTP error envelope and request correlation for ml-controller."""
from __future__ import annotations

import logging
import re
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)
_PUBLIC_ERROR_CODE = re.compile(r"^[a-z][a-z0-9_.:-]{0,127}$")


def public_http_error(status_code: int, detail: object) -> tuple[str, str]:
    """Map framework exceptions to a stable, non-sensitive client contract."""
    if status_code >= 500:
        return "upstream_or_internal_error", "The request could not be completed"
    if isinstance(detail, str) and _PUBLIC_ERROR_CODE.fullmatch(detail):
        return detail, detail
    return "request_rejected", "The request was rejected"


def install_http_error_policy(app: FastAPI) -> None:
    @app.middleware("http")
    async def request_correlation(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID", "").strip()[:128] or str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response

    @app.exception_handler(HTTPException)
    async def http_exception_handler(request: Request, exc: HTTPException):
        request_id = getattr(request.state, "request_id", None)
        code, message = public_http_error(exc.status_code, exc.detail)
        if exc.status_code >= 500:
            logger.error(
                "Controller HTTP failure status=%s method=%s path=%s request_id=%s detail=%r",
                exc.status_code,
                request.method,
                request.url.path,
                request_id,
                exc.detail,
            )
        return JSONResponse(
            status_code=exc.status_code,
            headers=exc.headers,
            content={
                "ok": False,
                "error": {"code": code, "message": message},
                "request_id": request_id,
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        request_id = getattr(request.state, "request_id", None)
        logger.exception(
            "Unhandled controller request error method=%s path=%s request_id=%s",
            request.method,
            request.url.path,
            request_id,
        )
        return JSONResponse(
            status_code=500,
            content={
                "ok": False,
                "error": {"code": "internal_error", "message": "Internal server error"},
                "request_id": request_id,
            },
        )
