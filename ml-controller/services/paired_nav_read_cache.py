"""Bounded job-local serialization of already verified immutable cold reads.

No persisted verdicts: callers still re-read the manifest/cold location and run
all comparison checks. Cached values deserialize independently (no shared
mutable dictionaries). Temporary storage is budgeted because Cloud Run tmpfs
counts towards container memory. No cache survives a job or failed scope.
"""
from collections import OrderedDict
from contextlib import contextmanager
from contextvars import ContextVar
import gzip
import json
import os
import pickle
import tempfile

_scope = ContextVar('paired_nav_cold_read_cache', default=None)


class _BudgetExceeded(Exception):
    pass


class _LimitedWriter:
    def __init__(self, output, limit):
        self.output, self.limit = output, limit

    def write(self, data):
        if self.output.tell() + len(data) > self.limit:
            raise _BudgetExceeded()
        return self.output.write(data)

    def flush(self):
        self.output.flush()


class _Cache:
    def __init__(self, directory, max_bytes, entry_bytes):
        self.directory, self.max_bytes, self.entry_bytes = directory, max_bytes, entry_bytes
        self.entries = OrderedDict()
        self.bytes = 0
        self.serial = 0
        self.comparisons = OrderedDict()
        self.definitions = OrderedDict()

    def read(self, key):
        entry = self.entries.get(key)
        if entry is None:
            return False, None
        self.entries.move_to_end(key)
        with gzip.open(entry[0], 'rb') as source:
            return True, pickle.load(source)

    def save(self, key, value):
        # Reserve enough space before writing, including the incomplete entry.
        while self.entries and self.bytes + self.entry_bytes > self.max_bytes:
            _, (path, size) = self.entries.popitem(last=False)
            os.unlink(path)
            self.bytes -= size
        self.serial += 1
        path = os.path.join(self.directory, str(self.serial))
        try:
            with open(path, 'wb') as raw:
                with gzip.GzipFile(fileobj=_LimitedWriter(raw, self.entry_bytes), mode='wb', compresslevel=1) as output:
                    pickle.dump(value, output, protocol=pickle.HIGHEST_PROTOCOL)
            size = os.path.getsize(path)
            self.entries[key] = (path, size)
            self.bytes += size
        except _BudgetExceeded:
            os.unlink(path)  # Oversize is a cache miss, never missing evidence.


@contextmanager
def reuse_verified_cold_reads(*, max_bytes=128 * 1024 * 1024, entry_bytes=64 * 1024 * 1024):
    if not 0 < entry_bytes <= max_bytes:
        raise ValueError('nav_read_cache_budget_invalid')
    if _scope.get() is not None:
        yield
        return
    with tempfile.TemporaryDirectory(prefix='nav-verified-cache-') as directory:
        token = _scope.set(_Cache(directory, max_bytes, entry_bytes))
        try:
            yield
        finally:
            _scope.reset(token)


def cached_verified_read(key, read):
    scope = _scope.get()
    if scope is None:
        return read()
    found, value = scope.read(key)
    if found:
        return value
    value = read()  # Only a successfully checksum-verified parse can be cached.
    scope.save(key, value)
    return value


def reusable_comparison(query, allocation):
    from services.paired_nav_journal import digest
    scope = _scope.get()
    if scope is None:
        return None
    key = (query, digest(allocation))
    cached = scope.comparisons.get(key)
    if cached is None:
        return None
    manifest, result = cached
    current = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [manifest['snapshot_id']])
    if current != [manifest]:
        raise RuntimeError('paired_nav_comparison_parent_changed')
    from copy import deepcopy
    return deepcopy(result)


def remember_comparison(query, allocation, parent, result):
    from services.paired_nav_journal import digest
    from copy import deepcopy
    scope = _scope.get()
    # These owners verify only the supplied immutable plan/parent. Atomic and
    # fusion have additional query dependencies and deliberately never reuse.
    if scope is None or allocation['payload']['content']['owner'] not in {'ensemble', 'l4_alpha_ev', 'l15_route'}:
        return
    if len(json.dumps([parent['manifest'], result], ensure_ascii=False).encode()) > 64 * 1024:
        return
    key = (query, digest(allocation))
    scope.comparisons[key] = (deepcopy(parent['manifest']), deepcopy(result))
    if len(scope.comparisons) > 256:
        scope.comparisons.popitem(last=False)


def remember_policy_definitions(query, manifest, owner, definitions):
    from copy import deepcopy
    scope = _scope.get()
    if scope is None or len(json.dumps([manifest, definitions], ensure_ascii=False).encode()) > 64 * 1024:
        return
    scope.definitions[(query, manifest['snapshot_id'], owner)] = (deepcopy(manifest), deepcopy(definitions))
    if len(scope.definitions) > 256:
        scope.definitions.popitem(last=False)


def policy_definitions(query, snapshot_id, owner, read):
    from copy import deepcopy
    scope = _scope.get()
    cached = scope.definitions.get((query, snapshot_id, owner)) if scope is not None else None
    if cached is not None:
        manifest, definitions = cached
        current = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
        if current != [manifest]:
            raise RuntimeError('paired_nav_policy_source_changed')
        return {'manifest': deepcopy(manifest), 'definitions': deepcopy(definitions)}
    result = read()
    remember_policy_definitions(query, result['manifest'], owner, result['definitions'])
    return result
