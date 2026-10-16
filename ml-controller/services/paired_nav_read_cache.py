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
import logging
from functools import wraps

def verified_reads_async(fn):
    @wraps(fn)
    async def wrapped(*args, **kwargs):
        with reuse_verified_cold_reads():
            return await fn(*args, **kwargs)
    return wrapped

def cache_event(event):
    logging.getLogger(__name__).info("[NavReadCache] event=%s", event)

_scope = ContextVar('paired_nav_cold_read_cache', default=None)


class ComparisonReads:
    """Exact pass-through; capture all successful read dependencies, including empty pages."""
    def __init__(self, original):
        self.original, self.reads, self.stable = original, {}, True

    def __call__(self, sql, params=None):
        from services.paired_nav_journal import digest
        from services.daily_nav_read_receipt import _readonly
        rows = self.original(sql, params)
        if self.stable:
            if not _readonly(sql) or len(self.reads) >= 512:
                self.stable = False
            else:
                item = {'sql': sql, 'params': params, 'checksum': digest(rows)}
                key = digest([sql, params])
                old = self.reads.get(key)
                if old is not None and old != item:
                    self.stable = False
                self.reads[key] = item
        return rows


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


class _CountingWriter:
    def __init__(self, limit):
        self.size, self.limit = 0, limit

    def write(self, data):
        if self.size + len(data) > self.limit:
            raise _BudgetExceeded()
        self.size += len(data)
        return len(data)

    def flush(self):
        pass


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

    def _reserve(self, key, size):
        # Replacing a projection must release its former tmpfs file as well as
        # its accounting entry. Otherwise repeated seeds leave unreachable files.
        previous = self.entries.pop(key, None)
        if previous is not None:
            os.unlink(previous[0])
            self.bytes -= previous[1]
        while self.entries and self.bytes + size > self.max_bytes:
            _, (path, old_size) = self.entries.popitem(last=False)
            os.unlink(path)
            self.bytes -= old_size

    def save_file(self, key, source):
        size = os.path.getsize(source)
        if size > self.entry_bytes:
            cache_event("file_oversize")
            return None
        self.serial += 1
        path = os.path.join(self.directory, str(self.serial))
        # Hard-link the already verified file: no second tmpfs allocation.
        try:
            os.link(source, path)
        except OSError:
            return None  # Filesystem without hard links: retain uncached reader.
        # Link first, so replacing a key also works if source is its old link.
        self._reserve(key, size)
        self.entries[key] = (path, size)
        self.bytes += size
        return path

    def save(self, key, value):
        # An oversized attempted projection must not evict all useful entries.
        # Count compressed bytes without retaining a document-sized buffer;
        # reserve only the successfully measured size before any tmpfs write.
        counter = _CountingWriter(self.entry_bytes)
        try:
            with gzip.GzipFile(filename='', fileobj=counter, mode='wb', compresslevel=1, mtime=0) as output:
                pickle.dump(value, output, protocol=pickle.HIGHEST_PROTOCOL)
        except _BudgetExceeded:
            cache_event('projection_oversize')
            return
        self._reserve(key, counter.size)
        self.serial += 1
        path = os.path.join(self.directory, str(self.serial))
        try:
            with open(path, 'wb') as raw:
                with gzip.GzipFile(filename='', fileobj=_LimitedWriter(raw, counter.size), mode='wb', compresslevel=1, mtime=0) as output:
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
        cache_event("projection_no_scope")
        return read()
    found, value = scope.read(key)
    if found:
        cache_event("projection_hit")
        return value
    cache_event("projection_miss")
    value = read()  # Only a successfully checksum-verified parse can be cached.
    scope.save(key, value)
    return value


def reusable_comparison(query, allocation, *, parent_manifest=None):
    from services.paired_nav_journal import digest
    scope = _scope.get()
    if scope is None:
        return None
    key = (query_cache_identity(query), digest(allocation))
    cached = scope.comparisons.get(key)
    if cached is None:
        return None
    manifest, result, dependencies = cached
    if parent_manifest is not None and parent_manifest != manifest:
        return None
    current = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [manifest['snapshot_id']])
    if current != [manifest]:
        raise RuntimeError('paired_nav_comparison_parent_changed')
    for item in dependencies:
        if digest(query(item['sql'], item['params'])) != item['checksum']:
            # Re-run the original verifier on the changed source. Never reuse
            # yesterday's success or omit a newly introduced dependency row.
            scope.comparisons.pop(key, None)
            return None
    from copy import deepcopy
    return deepcopy(result)


def remember_comparison(query, allocation, parent, result, *, dependencies=None):
    from services.paired_nav_journal import digest
    from copy import deepcopy
    scope = _scope.get()
    # Atomic/fusion reuse requires the complete additional query read set.
    if scope is None:
        return
    owner = allocation['payload']['content']['owner']
    if owner not in {'ensemble', 'l4_alpha_ev', 'l15_route'} and dependencies is None:
        return  # Additional dependencies must be captured, never assumed.
    dependencies = dependencies or []
    if len(json.dumps([parent['manifest'], result, dependencies], ensure_ascii=False).encode()) > 64 * 1024:
        return
    key = (query_cache_identity(query), digest(allocation))
    scope.comparisons[key] = (deepcopy(parent['manifest']), deepcopy(result), deepcopy(dependencies))
    if len(scope.comparisons) > 256:
        scope.comparisons.popitem(last=False)


def remember_policy_definitions(query, manifest, owner, definitions):
    from copy import deepcopy
    scope = _scope.get()
    if scope is None or len(json.dumps([manifest, definitions], ensure_ascii=False).encode()) > 64 * 1024:
        return
    scope.definitions[(query_cache_identity(query), manifest['snapshot_id'], owner)] = (deepcopy(manifest), deepcopy(definitions))
    if len(scope.definitions) > 256:
        scope.definitions.popitem(last=False)


def policy_definitions(query, snapshot_id, owner, read):
    from copy import deepcopy
    scope = _scope.get()
    cached = scope.definitions.get((query_cache_identity(query), snapshot_id, owner)) if scope is not None else None
    if cached is not None:
        manifest, definitions = cached
        current = query('SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [snapshot_id])
        if current != [manifest]:
            raise RuntimeError('paired_nav_policy_source_changed')
        return {'manifest': deepcopy(manifest), 'definitions': deepcopy(definitions)}
    result = read()
    remember_policy_definitions(query, result['manifest'], owner, result['definitions'])
    return result


@contextmanager
def cached_verified_file(key, acquire):
    """Scope-owned original compressed bytes; locator is freshly checked by caller."""
    scope = _scope.get()
    entry = scope.entries.get(('file', key)) if scope is not None else None
    if entry is not None:
        cache_event('file_hit')
        scope.entries.move_to_end(('file', key))
        yield entry[0]
        return
    cache_event("file_no_scope" if scope is None else "file_miss")
    with acquire() as path:
        # Caller parses before publishing this path; an invalid parse never
        # becomes a cached source. A parsed projection can subsequently evict it.
        yield path
        if scope is not None:
            scope.save_file(('file', key), path)


def query_cache_identity(query):
    # Proxy and direct clients for the same DB share verified bytes, while every
    # load still rereads both metadata rows. A routing change changes the key.
    from services.d1_domain_client import DomainD1Client, DomainD1ClientProxy, database_id_for_domain
    from services.daily_nav_read_receipt import RecordedClient
    from services.strategy_nav_read_model import DisplayRecordedClient
    from services.strategy_nav_accounting_scope import StrategyAccountingScope
    from services import d1_client
    original, seen = query, set()
    # Only exact known adapters share bytes. Scope filters apply exclusively
    # to pending execution pages; manifest/locator reads pass through unchanged.
    # Comparison reuse separately replays ALL queries through the actual caller.
    while True:
        owner, fn = getattr(query, '__self__', None), getattr(query, '__func__', None)
        if type(query) is ComparisonReads:
            wrapper, next_query = query, query.original
        elif (type(owner), fn) in ((RecordedClient, RecordedClient.query),
                                  (DisplayRecordedClient, DisplayRecordedClient.query)):
            wrapper, next_query = owner, owner.client.query
        elif type(owner) is StrategyAccountingScope and fn is StrategyAccountingScope.query:
            wrapper, next_query = owner, owner.original
        else:
            break
        if id(wrapper) in seen:
            return original
        seen.add(id(wrapper))
        query = next_query
    owner = getattr(query, '__self__', None)
    fn = getattr(query, '__func__', None)
    if (type(owner) in (DomainD1Client, DomainD1ClientProxy)
            and fn in (DomainD1Client.query, DomainD1ClientProxy.query)):
        database = database_id_for_domain(owner.domain, require_specific=getattr(owner, 'require_specific', False))
        return ('domain-d1', d1_client.CF_ACCOUNT_ID, database, d1_client.STRATEGY_MINING_D1_WORKER_ONLY)
    return query
