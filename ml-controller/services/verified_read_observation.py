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


def observed_read(key, sql, fetch):
    observations = _ACTIVE.get()
    if observations is None:
        return fetch()
    readonly = sql.lstrip().upper().startswith(('SELECT ', 'WITH ')) or re.fullmatch(
        r'\s*PRAGMA\s+(?:table_info|index_info|index_list|foreign_key_list)\s*\([a-zA-Z0-9_]+\)\s*;?\s*', sql, re.I)
    if not readonly:
        raise ValueError('verified_observation_read_only_required')
    if key not in observations:
        rows = fetch()
        observations[key] = (fetch, deepcopy(rows))
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
        for fetch, rows in observations.values():
            if fetch() != rows:
                raise RuntimeError('active8_serving_observation_changed')
    finally:
        if token is not None:
            _ACTIVE.reset(token)
