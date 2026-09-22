"""Explicit unobserved comparison outcome for late formal-paper recovery.

This never grants NAV credit or changes the native registration deadline.
"""
from datetime import datetime, timezone
import json
import re

from services.paired_nav_journal import read_snapshot, digest, _timestamp
from services.paired_native_registration import next_session
from services.paired_native_session import session_schedule


def missed_setup_window(collection, *, query, kv_read=None, now=None):
    # Failed sources must keep their failure, including retries with partial plans.
    if (collection.get('status') != 'allocation_context_frozen'
            or collection.get('owner_failures') or collection.get('native_execution')):
        return None
    saved = read_snapshot(query, collection['snapshot_id'])
    manifest, context = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'allocation_context':
        raise ValueError('paired_nav_allocation_context_required')
    if (context.get('inputs', {}).get('alpha_policy', {}).get('l4Distribution') is None
            or context.get('atomic_recommendation_inputs') is not None):
        return None  # Existing legacy and Atomic comparison contracts stay intact.
    selection = (context.get('recommendation_context') or {}).get('l3_candidate_selection') or {}
    if selection.get('status') == 'failed':
        raise ValueError('paired_nav_l3_candidate_selection_failed')
    if (context.get('opb_candidate_selection') or {}).get('status') == 'failed':
        raise ValueError('paired_nav_opb_candidate_selection_failed')
    if selection.get('status') != 'candidate_ensembles_frozen':
        return None
    if (selection.get('signal_date') != manifest['signal_date']
            or _timestamp(selection['decision_cutoff']) > _timestamp(manifest['frozen_at'])):
        raise ValueError('paired_nav_l3_selection_time_invalid')
    from services.paired_nav_execution_environment import configuration_environment
    if not configuration_environment(saved):
        raise ValueError('paired_nav_execution_environment_missing')
    if 'formal_output' not in context or not context.get('capture'):
        raise ValueError('paired_nav_formal_allocation_capture_missing')
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None:
        raise ValueError('paired_nav_timezone_required')
    if kv_read is None:
        from services.kv_client import get
        kv_read = lambda key: get(key, strict=True)
    session, calendar = next_session(manifest['signal_date'], kv_read=kv_read, now=clock)
    first_phase = session_schedule(session)[0]['observed_at']
    if clock < _timestamp(first_phase):
        return None
    window = {'schema_version': 'paired-nav-missed-setup-window-v1',
        'snapshot_id': manifest['snapshot_id'], 'signal_date': manifest['signal_date'],
        'allocation_context_checksum': manifest['payload_checksum'],
        'session_date': session, 'checked_at': clock.isoformat(),
        'first_phase_at': first_phase, 'calendar': calendar,
        'calendar_checksum': digest(calendar)}
    window['checksum'] = digest(window)
    return {**collection, 'status': 'missed_execution_window',
        'execution_evidence_status': 'not_observed', 'execution_window': window,
        'production_effect': False, 'promotion_allowed': False,
        'can_write_order': False, 'nav_maturity_credit': 0}


def valid_missed_window(collection):
    try:
        window = collection['execution_window']
        if (collection.get('status') != 'missed_execution_window'
                or collection.get('execution_evidence_status') != 'not_observed'
                or collection.get('owner_failures') or collection.get('native_execution')
                or collection.get('candidate_allocations')
                or any(collection.get(k) is not False for k in
                    ('production_effect', 'promotion_allowed', 'can_write_order'))
                or type(collection.get('nav_maturity_credit')) is not int
                or collection['nav_maturity_credit'] != 0
                or window['schema_version'] != 'paired-nav-missed-setup-window-v1'
                or window['snapshot_id'] != collection['snapshot_id']
                or not re.fullmatch('[0-9a-f]{64}', window['allocation_context_checksum'])
                or window['checksum'] != digest({k:v for k,v in window.items() if k != 'checksum'})
                or window['calendar_checksum'] != digest(window['calendar'])):
            return False
        def read_calendar(key):
            value = window['calendar'][key]
            return json.dumps(value) if isinstance(value, dict) else value
        checked = _timestamp(window['checked_at'])
        session, _ = next_session(window['signal_date'], kv_read=read_calendar, now=checked)
        first = session_schedule(session)[0]['observed_at']
        return (window['session_date'] == session and window['first_phase_at'] == first
                and checked >= _timestamp(first))
    except (KeyError, TypeError, ValueError):
        return False


def persist_missed_setup_window(collection, *, objects=None):
    """Use the existing private immutable store; first observation wins retries."""
    if not valid_missed_window(collection):
        raise ValueError('paired_nav_invalid_missed_execution_window')
    if objects is None:
        from services.paper_corporate_source import production_objects
        objects = production_objects()
    window = collection['execution_window']
    identity = {'kind': 'paired-nav-missed-setup-window-v1',
        'snapshot_id': collection['snapshot_id'], 'first_phase_at': window['first_phase_at']}
    delivery_id = digest(identity)
    key = objects.lookup_delivery(delivery_id)
    if key is None:
        key = objects.put({'identity': identity, 'collection': collection})
        key = objects.publish_delivery(delivery_id, key)
    saved = objects.get(key)
    original = saved.get('collection') or {}
    if (saved.get('identity') != identity or not valid_missed_window(original)
            or original['execution_window']['allocation_context_checksum'] != window['allocation_context_checksum']
            or _timestamp(original['execution_window']['checked_at']) > _timestamp(window['checked_at'])):
        raise ValueError('paired_nav_missed_window_receipt_mismatch')
    return {**original, 'execution_window_receipt': {
        'delivery_id': delivery_id, 'object_key': key, 'payload_checksum': digest(saved),
        'readback_verified': True}}


def valid_missed_window_receipt(collection):
    from services.native_paper_source_capture import ImmutableNativeObjects
    if not valid_missed_window(collection):
        return False
    receipt = collection.get('execution_window_receipt') or {}
    window = collection['execution_window']
    identity = {'kind': 'paired-nav-missed-setup-window-v1',
        'snapshot_id': collection['snapshot_id'], 'first_phase_at': window['first_phase_at']}
    original = {k:v for k,v in collection.items() if k not in {'execution_window_receipt','atomic_daily'}}
    checksum = digest({'identity': identity, 'collection': original})
    return (receipt.get('readback_verified') is True
        and receipt.get('delivery_id') == digest(identity)
        and receipt.get('payload_checksum') == checksum
        and receipt.get('object_key') == ImmutableNativeObjects.PREFIX + checksum + '.json')
