"""Task-local input/inference/audit ports for the ORIGINAL debate algorithm."""
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class DebateExecutionPorts:
    max_rounds: int
    infer: Callable[..., Any]
    audit: Callable[..., Any]
    model_assignment: str | None = 'gemini'


_CURRENT: ContextVar[DebateExecutionPorts | None] = ContextVar('private_debate_execution', default=None)


def current_debate_execution():
    return _CURRENT.get()


@contextmanager
def private_debate_execution(ports: DebateExecutionPorts):
    if _CURRENT.get() is not None:
        raise ValueError('native_debate_nested_scope')
    if type(ports.max_rounds) is not int or not 1 <= ports.max_rounds <= 3:
        raise ValueError('native_debate_rounds_invalid')
    if ports.model_assignment not in (None, 'gemini'):
        raise ValueError('native_debate_assignment_invalid')
    token = _CURRENT.set(ports)
    try:
        yield
    finally:
        _CURRENT.reset(token)
