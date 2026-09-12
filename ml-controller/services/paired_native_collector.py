"""Durable per-frame BOTH-arm collection using the original native engine.

The delivery chain is the checkpoint. There is no mutable current-state pointer:
an interrupted frame reuses sealed input reads and only publishes after BOTH
arms have succeeded. Late retries cannot fill a missing historical source read.
"""
from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path

from services.native_paper_sandbox import run_native_paper_frames
from services.paired_native_session import ARMS, validate_schedule, run_paired_session
from services.paired_nav_journal import _timestamp, digest, read_snapshot
from services.native_paper_time import frame_capture_deadline


def frame_identity(snapshot_id: str, frame: dict) -> dict:
    return {'kind': 'paired-native-frame-v1', 'snapshot_id': snapshot_id, 'frame': frame}


def collect_frame(*, snapshot_id: str, frame_index: int, objects, query, capture_source,
                  runner: Path | None = None, now: datetime | None = None) -> dict:
    saved = read_snapshot(query, snapshot_id)
    packet, manifest = saved['payload']['content'], saved['manifest']
    if manifest['snapshot_kind'] != 'execution_pair' or manifest['prospective'] != 1:
        raise ValueError('paired_native_prospective_pair_required')
    schedule = packet['schedule']
    validate_schedule(schedule, packet['session_date'])
    if type(frame_index) is not int or not 0 <= frame_index < len(schedule):
        raise ValueError('paired_native_frame_index_invalid')
    if _timestamp(manifest['frozen_at']) >= _timestamp(schedule[0]['observed_at']):
        raise ValueError('paired_native_pair_not_frozen_before_first_phase')
    frame = schedule[frame_index]
    identity = frame_identity(snapshot_id, frame)
    delivery_id = digest(identity)
    existing = objects.lookup_delivery(delivery_id)
    if existing:
        return objects.get(existing)
    clock = now or datetime.now(timezone.utc)
    if clock.tzinfo is None or clock < _timestamp(frame['observed_at']):
        raise ValueError('paired_native_frame_not_due')
    if clock >= frame_capture_deadline(frame):
        raise ValueError('paired_native_expired_frame_without_receipt')
    previous_key = None
    if frame_index:
        previous_key = objects.lookup_delivery(digest(frame_identity(snapshot_id, schedule[frame_index - 1])))
        if previous_key is None:
            raise ValueError('paired_native_previous_frame_missing')
        states = objects.get(previous_key)['states']
    else:
        states = {arm: objects.get(packet['initial_state_objects'][arm]) for arm in ARMS}
        if any(states[arm]['state_checksum'] != packet['initial_state_checksums'][arm] for arm in ARMS):
            raise ValueError('paired_native_start_state_changed')
    outputs = {}
    arm_selector = getattr(capture_source, 'for_arm', None)
    from services.paired_native_models import DUAL_INPUT_OWNERS, prediction_arms
    if packet.get('owner') in DUAL_INPUT_OWNERS and not callable(arm_selector):
        raise ValueError('paired_native_' + packet['owner'] + '_arm_capture_required')
    if packet.get('owner') in DUAL_INPUT_OWNERS:
        prediction_arms(packet)
    for arm in ARMS:
        inputs = {frame['input_id']: {**frame, 'source_tables': packet['source_tables'],
                                    'capture_kv_reads': packet.get('capture_kv_reads', False),
                                    'kv_read_policy': packet.get('kv_read_policy', {})}}
        outputs[arm] = run_native_paper_frames(**states[arm], frames=[frame], frame_inputs=inputs,
            account_id=packet['account_id'], variables=packet['variables'], runner=runner,
            expected_execution_owner_version=packet['execution_owner_version'],
            capture_source=arm_selector(arm) if callable(arm_selector) else capture_source)
        from services.paired_native_models import validate_model_frame
        validate_model_frame(packet, arm, outputs[arm]['captured_inputs'][frame['input_id']])
    result = {'identity': identity, 'previous_frame_object': previous_key,
        'states': {arm: {key: outputs[arm][key] for key in ('state_sql', 'state_checksum')} for arm in ARMS},
        'frames': {arm: outputs[arm]['frames'][0] for arm in ARMS},
        'inputs': {arm: outputs[arm]['captured_inputs'][frame['input_id']] for arm in ARMS},
        'production_effect': False, 'session_complete': False, 'nav_maturity_credit': 0}
    key = objects.put(result)
    authoritative_key = objects.publish_delivery(delivery_id, key)
    # First writer wins, but differing state is an error, not a silent overwrite.
    if authoritative_key != key:
        raise RuntimeError('paired_native_concurrent_frame_conflict')
    return objects.get(authoritative_key)


def close_collected_session(*, snapshot_id: str, objects, query, writer, source_receipt: dict,
                            runner: Path | None = None, now: datetime | None = None) -> dict:
    saved = read_snapshot(query, snapshot_id)
    packet = saved['payload']['content']
    schedule = packet['schedule']
    validate_schedule(schedule, packet['session_date'])
    tapes = {arm: {'frames': {}, 'source_receipt': source_receipt} for arm in ARMS}
    previous_key = None
    for frame in schedule:
        key = objects.lookup_delivery(digest(frame_identity(snapshot_id, frame)))
        if key is None:
            raise ValueError('paired_native_frame_receipt_missing:' + frame['input_id'])
        record = objects.get(key)
        if record['identity'] != frame_identity(snapshot_id, frame) or record['previous_frame_object'] != previous_key:
            raise ValueError('paired_native_frame_chain_mismatch')
        for arm in ARMS:
            tapes[arm]['frames'][frame['input_id']] = record['inputs'][arm]
        previous_key = key
    # Replay all recorded reads with NO external capability. This also verifies
    # that process restarts did not alter original native portfolio behavior.
    states = {arm: objects.get(packet['initial_state_objects'][arm]) for arm in ARMS}
    return run_paired_session(snapshot_id=snapshot_id, tapes=tapes, states=states, query=query,
        writer=writer, runner=runner, now=now, state_objects=objects,
        expected_final_checksums={arm: record['states'][arm]['state_checksum'] for arm in ARMS})
