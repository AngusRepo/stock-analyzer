"""Request-local duplicate reads for UI, with a fresh full source check on exit.

Not a TTL cache or serving-grant cache. The production inference reader does
not enter this scope. Unknown columns, NULLs and schema reads remain checked.
"""
from contextlib import contextmanager
from contextvars import ContextVar
from copy import deepcopy
import re

_ACTIVE = ContextVar('verified_read_observation', default=None)


def observation_active():
    return _ACTIVE.get() is not None


def observed_read(key, sql, fetch, *, batch=None):
    observations = _ACTIVE.get()
    if observations is None:
        return fetch()
    readonly = sql.lstrip().upper().startswith(('SELECT ', 'WITH ')) or re.fullmatch(
        r'\s*PRAGMA\s+(?:table_info|index_info|index_list|foreign_key_list)\s*\([a-zA-Z0-9_]+\)\s*;?\s*', sql, re.I)
    if not readonly:
        raise ValueError('verified_observation_read_only_required')
    return observed_value(('sql', key), fetch, batch=batch)


def observed_value(key, fetch, *, batch=None):
    """Reuse a value only inside this UI read; reread it fully before exit."""
    observations = _ACTIVE.get()
    if observations is None:
        return fetch()
    if key not in observations:
        observations[key] = (fetch, deepcopy(fetch()), batch)
    return deepcopy(observations[key][1])


@contextmanager
def verified_read_observation():
    if _ACTIVE.get() is not None:
        raise RuntimeError('verified_observation_nested_scope')
    observations = {}
    token = _ACTIVE.set(observations)
    try:
        yield
        # Disable memoization before rereading the real provider. A source
        # change or transport failure prevents the caller from returning.
        _ACTIVE.reset(token)
        token = None
        batches = {}
        for fetch, rows, batch in observations.values():
            if batch is not None:
                group, request, batch_fetch = batch
                batches.setdefault(group, (batch_fetch, []))[1].append((request, rows))
            elif fetch() != rows:
                raise RuntimeError('active8_serving_observation_changed')
        for batch_fetch, items in batches.values():
            actual = batch_fetch([request for request, _ in items])
            if len(actual) != len(items) or any(current != rows for current, (_, rows) in zip(actual, items)):
                raise RuntimeError('active8_serving_observation_changed')
    finally:
        if token is not None:
            _ACTIVE.reset(token)
