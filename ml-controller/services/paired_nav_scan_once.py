"""One verified scan per cold NAV snapshot for every projection a job reads.

The daily NAV closure reads the same large allocation contexts in several
sweeps (census, Atomic owner, route owner), each with its own projection
prefix set. The shared verified-read cache keys a projection by its exact
prefix set and evicts it LRU next to multi-MB small-snapshot entries, so every
sweep re-downloaded and re-tokenised 0.7-2.4 GB of JSON (27-125 s per read).

This scope keeps that cache and its semantics, and adds a per-snapshot bundle:
the first projection miss of a snapshot downloads it once, verifies the
complete payload checksum while tokenising, and records the selections for
the union of every prefix the job asks for. Any later prefix set of that
snapshot is replayed from the bundle with the exact assignment order of
streaming_json_reader._parse, so callers receive byte-identical values.

Unchanged: the caller still rereads manifest and cold locator before every
lookup (they are part of the key), only a fully checksum-verified scan is
stored, any scan failure falls back to the original reader (which raises its
original error), values never share objects with the cache, and nothing
survives the scope. paired_nav_read_cache.py and paired_nav_cold.py are part
of the native execution identity and are deliberately not modified.
"""
from collections import OrderedDict
from contextlib import contextmanager
import gzip
import inspect
import json
import logging
import os
import pickle
import tempfile

from services import paired_nav_cold
from services import paired_nav_read_cache
from services.paired_nav_journal import _INVENTORY_PREFIXES

# Technical cache budgets only; no trading decision depends on them.
# Measured 2026-10-29 on production cold objects: the daily NAV prefix union of
# one context is <= 0.5 MB as gzip-1 pickle (1.1-2.4 GB raw JSON). 49 contexts
# fit in ~25 MB; 64 MiB leaves headroom while staying far below the 8Gi job
# (Cloud Run tmpfs counts as memory). A bundle above 8 MiB means a caller asked
# for bulk history: it is served once and not retained.
BUNDLE_BUDGET_BYTES = 64 * 1024 * 1024
BUNDLE_ENTRY_BYTES = 8 * 1024 * 1024

# Every daily-NAV projection of an allocation context: the selection inventory
# (both owner variants are subsets), Atomic child delta keys and the comparison
# / policy validation fields. Another prefix joins only its own snapshot's union
# (never every later scan): a bulk or enclosing request must not inflate them.
STATIC_PREFIXES = frozenset(_INVENTORY_PREFIXES | {'content.' + field for field in (
    'context_layout', 'upstream_payload_checksum', 'trading_config',
    'native_execution_environment', 'formal_baseline_identity', 'formal_output')})


def _event(name):
    paired_nav_read_cache.cache_event(name)


def _assign(result, prefix, value):
    # Identical to streaming_json_reader._parse.assign.
    parent = result
    parts = prefix.split('.')
    for part in parts[:-1]:
        parent = parent.setdefault(part, {})
    parent[parts[-1]] = value


def _selections(source, prefixes, use_float):
    """streaming_json_reader._parse with the assign step recorded, not applied."""
    import ijson
    from decimal import Decimal
    keys, builder, selected, depth, found = {}, None, None, 0, []
    for prefix, event, value in ijson.parse(source, use_float=use_float):
        if selected is None:
            if prefix not in prefixes or event in ('map_key', 'end_map', 'end_array'):
                continue
            selected, builder, depth = prefix, ijson.ObjectBuilder(), 0
        if event == 'map_key':
            value = keys.setdefault(value, value)
        elif isinstance(value, Decimal):
            value = float(value)
        builder.event(event, value)
        depth += int(event in ('start_map', 'start_array')) - int(event in ('end_map', 'end_array'))
        if depth == 0:
            found.append((selected, builder.value))
            selected = None
    return found


def _load_selections(source, prefixes):
    """streaming_json_reader.load: BOM handling and the exact numeric fallback."""
    from ijson.common import JSONError
    start = source.tell()
    if source.read(3) == b'\xef\xbb\xbf':
        start = source.tell()
    source.seek(start)
    try:
        return _selections(source, prefixes, True)
    except JSONError as exc:
        if not any(word in str(exc).lower() for word in ('overflow', 'underflow')):
            raise
    source.seek(start)
    return _selections(source, prefixes, False)


def verified_selections(path, prefixes, *, checksum, byte_count):
    """paired_nav_cold.parse_file's verification around a multi-prefix scan."""
    from ijson.common import JSONError
    with gzip.open(path, 'rb') as source:
        verified = paired_nav_cold._VerifiedJsonSource(source, checksum, byte_count)
        try:
            found = _load_selections(verified, prefixes)
        except (JSONError, StopIteration):
            verified.verify()
            raise
        verified.verify()
        return found


def derivable(requested, scanned):
    """A union scan reproduces a prefix-set scan unless an extra scanned prefix
    encloses a requested one (it would swallow that prefix's events)."""
    if not requested <= scanned:
        return False
    extra = scanned - requested
    return not any(p.startswith(q + '.') for p in requested for q in extra)


def project(found, requested):
    result = {}
    for prefix, value in found:
        if prefix in requested:
            _assign(result, prefix, value)
    return result


def _projection_key(key):
    """(source_key, prefixes, row) for paired_nav_cold.load's projection key."""
    if not isinstance(key, tuple) or len(key) != 5 or key[3] is not True or not isinstance(key[4], tuple):
        return None
    try:
        row = json.loads(key[2])
    except (TypeError, ValueError):
        return None
    if (not isinstance(row, dict) or not isinstance(row.get('object_key'), str)
            or not isinstance(row.get('payload_checksum'), str) or type(row.get('payload_bytes')) is not int):
        return None
    if not key[4] or not all(isinstance(p, str) for p in key[4]):
        return None
    return key[:3], frozenset(key[4]), row


class SnapshotScanCache(paired_nav_read_cache._Cache):
    def __init__(self, directory, max_bytes, entry_bytes, *, bundle_budget=BUNDLE_BUDGET_BYTES,
                 bundle_entry=BUNDLE_ENTRY_BYTES):
        super().__init__(directory, max_bytes, entry_bytes)
        self.bundles = OrderedDict()  # source_key -> (path, size, scanned prefixes)
        self.bundle_bytes, self.bundle_budget, self.bundle_entry = 0, bundle_budget, bundle_entry
        self.scans = 0

    def read(self, key):
        found, value = super().read(key)
        if found:
            return found, value
        parsed = _projection_key(key)
        if parsed is None:
            return False, None
        source_key, requested, row = parsed
        if ('file', source_key) in self.entries:
            return False, None  # Retained small file: the original reader is already cheap.
        bundle = self.bundles.get(source_key)
        if bundle is not None and derivable(requested, bundle[2]):
            self.bundles.move_to_end(source_key)
            with gzip.open(bundle[0], 'rb') as source:
                selections = pickle.load(source)
            _event('projection_scan_hit')
            return True, project(selections, requested)
        scanned = STATIC_PREFIXES | requested | (bundle[2] if bundle is not None else frozenset())
        if not derivable(requested, scanned):
            return False, None  # Enclosing prefix: let the original exact reader parse.
        try:
            selections = self._scan(row, scanned)
        except Exception:
            # Never cache a failed or unverified scan; the original reader
            # re-runs and raises its own error (checksum, parse, locator).
            logging.getLogger(__name__).warning('[NavScanOnce] scan failed; original reader retries', exc_info=True)
            _event('projection_scan_failed')
            return False, None
        self._keep(source_key, scanned, selections)
        return True, project(selections, requested)

    def _scan(self, row, scanned):
        store = paired_nav_cold.production_store()
        if store is None:
            raise RuntimeError('paired_nav_cold_store_unavailable')
        with paired_nav_cold._downloaded_file(store, row['object_key']) as path:
            found = verified_selections(path, scanned, checksum=row['payload_checksum'],
                                        byte_count=row['payload_bytes'])
        self.scans += 1
        _event('projection_scan')
        return found

    def _keep(self, source_key, scanned, selections):
        previous = self.bundles.pop(source_key, None)
        if previous is not None:
            os.unlink(previous[0])
            self.bundle_bytes -= previous[1]
        data = gzip.compress(pickle.dumps(selections, protocol=pickle.HIGHEST_PROTOCOL), compresslevel=1, mtime=0)
        if len(data) > self.bundle_entry:
            _event('projection_scan_oversize')
            return
        while self.bundles and self.bundle_bytes + len(data) > self.bundle_budget:
            _, (path, size, _) = self.bundles.popitem(last=False)
            os.unlink(path)
            self.bundle_bytes -= size
        self.serial += 1
        path = os.path.join(self.directory, 'scan-' + str(self.serial))
        with open(path, 'wb') as output:
            output.write(data)
        self.bundles[source_key] = (path, len(data), scanned)
        self.bundle_bytes += len(data)


_DEFAULTS = inspect.signature(paired_nav_read_cache.reuse_verified_cold_reads).parameters


@contextmanager
def scan_each_snapshot_once(*, max_bytes=_DEFAULTS['max_bytes'].default,
                            entry_bytes=_DEFAULTS['entry_bytes'].default,
                            bundle_budget=BUNDLE_BUDGET_BYTES, bundle_entry=BUNDLE_ENTRY_BYTES):
    """Drop-in for reuse_verified_cold_reads(); nested scopes reuse this one."""
    if not 0 < entry_bytes <= max_bytes or not 0 < bundle_entry <= bundle_budget:
        raise ValueError('nav_read_cache_budget_invalid')
    scope = paired_nav_read_cache._scope
    if scope.get() is not None:
        yield
        return
    with tempfile.TemporaryDirectory(prefix='nav-verified-cache-') as directory:
        cache = SnapshotScanCache(directory, max_bytes, entry_bytes,
                                  bundle_budget=bundle_budget, bundle_entry=bundle_entry)
        token = scope.set(cache)
        try:
            yield cache
        finally:
            scope.reset(token)
            logging.getLogger(__name__).info('[NavScanOnce] scans=%d bundles=%d bundle_bytes=%d',
                                             cache.scans, len(cache.bundles), cache.bundle_bytes)
