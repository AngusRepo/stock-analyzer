"""Bounded display projection of the ORIGINAL NAV verifier.

HTTP never downloads/replays cold originals. A nightly/offline producer records
its complete SQL read set; every request rechecks it, including empty pages,
schema and checksums. This is display-only and cannot authorize adoption.
"""
from datetime import datetime
import json
import logging
import os
import threading
import time
from services.daily_nav_read_receipt import (
    RecordedClient, GcsReceiptStore, MAX_RECEIPT_BYTES, code_identity, unchanged, _digest, _readonly,
)
from services.paired_nav_policy_daily import (
    _clock, read_all_strategy_nav_evidence, select_strategy_nav_evidence,
)

SCHEMA = 'strategy-nav-read-model-v1'
PREFIX = 'strategy-nav-read-model/v1/'
log = logging.getLogger(__name__)


def _key(day, identity):
    return PREFIX + day + '/' + identity + '.json'


def _latest_key(identity):
    return PREFIX + 'latest/' + identity + '.json'


def _pointer(receipt):
    return {'business_date': receipt['business_date'], 'code_identity': receipt['code_identity'],
        'key': _key(receipt['business_date'], receipt['code_identity']),
        'evaluated_at': receipt['evidence']['observed_at']}


class StrategyNavReceiptStore(GcsReceiptStore):
    def publish_latest(self, receipt):
        from google.api_core.exceptions import NotFound, PreconditionFailed
        proposed = _pointer(receipt)
        blob = self.bucket.blob(_latest_key(receipt['code_identity']))
        for _ in range(3):
            try:
                blob.reload()
                if blob.size > 4096:
                    raise ValueError('strategy_nav_read_model_index_invalid')
                generation = blob.generation
                prior = json.loads(blob.download_as_bytes(if_generation_match=generation))
                # An old replay cannot move the display frontier backwards.
                if (prior['business_date'], datetime.fromisoformat(prior['evaluated_at'])) >= (
                        proposed['business_date'], datetime.fromisoformat(proposed['evaluated_at'])):
                    return
            except NotFound:
                generation = 0
            except PreconditionFailed:
                continue
            try:
                blob.upload_from_string(json.dumps(proposed).encode(), content_type='application/json',
                    if_generation_match=generation)
                return
            except PreconditionFailed:
                continue
        raise ValueError('strategy_nav_read_model_index_concurrent_update')


def _valid(receipt, day, identity, now):
    if (not isinstance(receipt, dict) or receipt.get('schema_version') != SCHEMA
            or receipt.get('business_date') != day or receipt.get('code_identity') != identity
            or receipt.get('promotion_allowed') is not False):
        raise ValueError('strategy_nav_read_model_identity_invalid')
    evidence = receipt['evidence']
    if (evidence['as_of_date'] != day or receipt['evidence_checksum'] != _digest(evidence)
            or receipt['reads_checksum'] != _digest(receipt['reads'])
            or len(json.dumps(receipt, ensure_ascii=False).encode()) > MAX_RECEIPT_BYTES):
        raise ValueError('strategy_nav_read_model_checksum_invalid')
    observed = datetime.fromisoformat(evidence['observed_at'])
    if observed.tzinfo is None or observed > now:
        raise ValueError('strategy_nav_read_model_clock_invalid')
    if any(e['status'] != 'available' and e.get('error') != 'nav_policy_original_allocation_missing'
           for e in evidence['entries']):
        raise ValueError('strategy_nav_read_model_original_unverified')
    return evidence


def read_strategy_nav_read_model(*, strategy_id, strategy_version, business_date, client, store, now=None):
    started = time.monotonic()
    stages = {}
    outcome = 'error'
    def measure(name, run):
        tick = time.monotonic()
        try:
            return run()
        finally:
            stages[name] = round(time.monotonic() - tick, 4)
    try:
        result = _read_strategy_nav_read_model(strategy_id=strategy_id, strategy_version=strategy_version,
            business_date=business_date, client=client, store=store, now=now, measure=measure)
        outcome = 'success'
        return result
    finally:
        elapsed = time.monotonic() - started
        # Fixed stage names and numbers only; no strategy/account, object key,
        # SQL, payload or exception text. Errors retain their original contract.
        emit = log.warning if elapsed >= 5.0 else log.debug
        emit('[StrategyNavRead] outcome=%s elapsed_s=%.4f stages_s=%s', outcome, elapsed,
             json.dumps(stages, sort_keys=True))


def _read_strategy_nav_read_model(*, strategy_id, strategy_version, business_date, client, store, measure, now=None):
    clock = _clock(business_date, now)
    identity = measure('source_identity', code_identity)
    receipt = measure('gcs_requested', lambda: store.read(_key(business_date, identity)))
    effective_date = business_date
    if receipt is None:
        pointer = measure('gcs_latest', lambda: store.read(_latest_key(identity)))
        if pointer is not None:
            effective_date = pointer['business_date']
            _clock(effective_date, clock)
            if (pointer.get('code_identity') != identity or pointer.get('key') != _key(effective_date, identity)):
                raise ValueError('strategy_nav_read_model_index_invalid')
            if effective_date <= business_date:
                receipt = measure('gcs_prior', lambda: store.read(pointer['key']))
    if receipt is None:
        raise ValueError('strategy_nav_read_model_missing')
    evidence = _valid(receipt, effective_date, identity, clock)
    if not measure('d1_source_validation', lambda: unchanged(client, receipt['reads'])):
        raise ValueError('strategy_nav_read_model_source_changed')
    result = select_strategy_nav_evidence(evidence, strategy_id=strategy_id, strategy_version=strategy_version)
    result['read_model'] = {'schema_version': SCHEMA, 'source_checked_at': clock.isoformat(),
        'evaluated_at': evidence['observed_at'], 'source_read_count': len(receipt['reads']),
        'promotion_allowed': False, 'requested_as_of_date': business_date,
        'is_prior_business_date': effective_date < business_date}
    return result


class DisplayRecordedClient(RecordedClient):
    """Refuse a projection whose dependency replay itself would be unbounded."""
    def query(self, sql, params=None, *args, **kwargs):
        if not _readonly(sql):
            raise ValueError('strategy_nav_read_model_read_only')
        rows = super().query(sql, params, *args, **kwargs)
        size = sum(len(piece.encode()) for piece in json.JSONEncoder(
            ensure_ascii=False, separators=(',', ':'), allow_nan=False).iterencode(rows))
        if size > MAX_RECEIPT_BYTES:
            raise ValueError('strategy_nav_read_model_dependency_too_large')
        return rows


def refresh_strategy_nav_read_model(*, business_date, client, store, now=None):
    from services.paired_nav_read_cache import reuse_verified_cold_reads
    from services.paired_nav_evidence import reuse_verified_nav_evidence
    from services.d1_client import read_connection_scope
    clock = _clock(business_date, now)
    identity = code_identity()
    key = _key(business_date, identity)
    receipt = store.read(key)
    current = False
    if receipt is not None:
        try:
            _valid(receipt, business_date, identity, clock)
            current = unchanged(client, receipt['reads'])
        except (ValueError, KeyError, TypeError):
            pass  # Only unverified originals need rebuilding.
    if current:
        # A contested display index must not restart the expensive verifier.
        store.publish_latest(receipt)
        return {'status': 'current', 'entry_count': len(receipt['evidence']['entries']),
            'original_payload_reads': 0, 'promotion_allowed': False}
    recorded = DisplayRecordedClient(client)
    with read_connection_scope(), reuse_verified_cold_reads(), reuse_verified_nav_evidence():
        evidence = read_all_strategy_nav_evidence(business_date=business_date, query=recorded.query, now=clock)
    receipt = {'schema_version': SCHEMA, 'business_date': business_date,
        'code_identity': identity, 'evidence': evidence, 'evidence_checksum': _digest(evidence),
        'reads': list(recorded.reads.values()), 'promotion_allowed': False}
    receipt['reads_checksum'] = _digest(receipt['reads'])
    _valid(receipt, business_date, identity, clock)
    if not recorded.stable or not unchanged(client, receipt['reads']):
        raise ValueError('strategy_nav_read_model_source_changed')
    raw = json.dumps(receipt, ensure_ascii=False, allow_nan=False).encode()
    if len(raw) > MAX_RECEIPT_BYTES:
        raise ValueError('strategy_nav_read_model_budget_exceeded')
    store.write(key, raw)
    store.publish_latest(receipt)
    return {'status': 'published', 'entry_count': len(evidence['entries']),
        'source_read_count': len(receipt['reads']), 'bytes': len(raw), 'promotion_allowed': False}


_READ_TRANSPORT = threading.local()


def production_read_store():
    # Reuse transport/auth within one worker thread only. No evidence, source
    # verdict, Blob metadata or generation is cached; read() reloads each time.
    # A fork or bucket change must construct its own client.
    identity = (os.getpid(), os.environ.get('GCS_BUCKET_NAME', '').strip())
    prior = getattr(_READ_TRANSPORT, 'state', None)
    if prior is not None and prior[0] == identity:
        return prior[1]
    from services.walk_forward_retrain import _get_bucket
    bucket = _get_bucket()
    if bucket is None:
        raise ValueError('strategy_nav_read_model_store_unavailable')
    store = StrategyNavReceiptStore(bucket)
    _READ_TRANSPORT.state = (identity, store)
    if prior is not None and prior[0][0] == identity[0]:
        try:
            prior[1].bucket.client.close()
        except Exception:
            log.warning('[StrategyNavRead] retired_transport_close_failed')
    return store
