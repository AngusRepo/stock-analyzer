"""Structured (one JSON object per line) logging and the L1 correlation id.

Cloud Logging parses a JSON stdout/stderr line into jsonPayload and maps `severity`, `message`
and `time`, so `jsonPayload.root_ticket_id="..."` finds every line of one scheduler run across the
Worker, ml-controller and the Cloud Run Jobs it launches. Only the line format changes: levels,
handlers and message text stay what they were (basicConfig semantics: a process whose root logger
already has handlers is left alone).
"""
from __future__ import annotations

import contextvars
import json
import logging
import os
import re
from datetime import datetime, timezone

ROOT_TICKET_ENV = 'STOCKVISION_ROOT_TICKET_ID'
ROOT_TICKET_HEADER = 'x-root-ticket-id'
_ROOT_TICKET_RE = re.compile(r'^[A-Za-z0-9:._-]{1,200}$')

# Request scope (ml-controller service) or, in a Cloud Run Job, the env the controller set.
_root_ticket: contextvars.ContextVar[str | None] = contextvars.ContextVar('root_ticket_id', default=None)


def valid_root_ticket_id(value: object) -> str | None:
    text = str(value or '').strip()
    return text if _ROOT_TICKET_RE.fullmatch(text) else None


def current_root_ticket_id() -> str | None:
    return _root_ticket.get() or valid_root_ticket_id(os.environ.get(ROOT_TICKET_ENV))


def set_root_ticket_id(value: object) -> contextvars.Token:
    return _root_ticket.set(valid_root_ticket_id(value))


def reset_root_ticket_id(token: contextvars.Token) -> None:
    _root_ticket.reset(token)


class JsonLogFormatter(logging.Formatter):
    """One JSON object per record; the message text is exactly record.getMessage() (+ traceback)."""

    def format(self, record: logging.LogRecord) -> str:
        message = record.getMessage()
        if record.exc_info:
            message = f'{message}\n{self.formatException(record.exc_info)}'
        if record.stack_info:
            message = f'{message}\n{self.formatStack(record.stack_info)}'
        payload = {
            'severity': record.levelname,
            'message': message,
            'logger': record.name,
            'time': datetime.fromtimestamp(record.created, timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
        }
        root = current_root_ticket_id()
        if root:
            payload['root_ticket_id'] = root
        return json.dumps(payload, ensure_ascii=False, default=str)


def configure_json_logging(level: int | str = logging.WARNING) -> None:
    """basicConfig equivalent with a JSON formatter; also reformats uvicorn's own handlers."""
    formatter = JsonLogFormatter()
    root = logging.getLogger()
    if not root.handlers:
        handler = logging.StreamHandler()
        handler.setFormatter(formatter)
        root.addHandler(handler)
        root.setLevel(level)
    # uvicorn configures these before importing the app; keep their levels, change only the format.
    for name in ('uvicorn', 'uvicorn.error', 'uvicorn.access'):
        for handler in logging.getLogger(name).handlers:
            handler.setFormatter(formatter)


class RootTicketMiddleware:
    """Pure ASGI middleware: binds X-Root-Ticket-Id to the request's context (and its tasks)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope.get('type') != 'http':
            return await self.app(scope, receive, send)
        value = None
        for key, raw in scope.get('headers') or ():
            if key.decode('latin-1').lower() == ROOT_TICKET_HEADER:
                value = raw.decode('latin-1')
                break
        token = set_root_ticket_id(value)
        try:
            return await self.app(scope, receive, send)
        finally:
            reset_root_ticket_id(token)
