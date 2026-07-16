"""Uniform HTTP error envelope and request correlation for the ML service."""
from __future__ import annotations

import logging
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse


logger = logging.getLogger(__name__)


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
        detail = exc.detail if isinstance(exc.detail, str) else "request_failed"
        return JSONResponse(
            status_code=exc.status_code,
            headers=exc.headers,
            content={
                "ok": False,
                "error": {"code": detail, "message": detail},
                "request_id": request_id,
            },
        )

    @app.exception_handler(Exception)
    async def unhandled_exception_handler(request: Request, exc: Exception):
        request_id = getattr(request.state, "request_id", None)
        logger.exception(
            "Unhandled ML request error method=%s path=%s request_id=%s",
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
