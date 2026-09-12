"""Original collector/session with Atomic inputs. Synthetic software evidence only."""
from copy import deepcopy
from datetime import datetime, timezone
import json

import pytest

from services.paired_nav_journal import digest, freeze_snapshot, read_snapshot, mature_staged_pairs
from services.paired_native_collector import collect_frame, frame_identity
from services.paired_native_session import run_paired_session
from services.native_paper_source_capture import NativeSourceCapture, ImmutableNativeObjects
from test_native_paper_sandbox import native_runner
from test_native_paper_source_capture import Bucket
from test_paired_native_session import paired_fixture
from test_paired_native_models import packet as model_packet, capture


def atomic_fixture(runner, *, missing_models=False):
    db, args = paired_fixture(runner)
    # A new isolated database has no unrelated missing-session registrations.
    packet = deepcopy(read_snapshot(db.query, args['snapshot_id'])['payload']['content'])
    db.conn.close()
    db = type(db)()
    model = model_packet('atomic_strategy')
    packet.update({k: deepcopy(model[k]) for k in ('owner', 'candidate_checksum', 'baseline_checksum',
        'model_predictions', 'model_predictions_checksum', 'model_prediction_arms', 'model_prediction_arms_checksum')})
    packet['configuration']['formal_baseline_identity'] = model['configuration']['formal_baseline_identity']
    packet['configuration_checksum'] = digest(packet['configuration'])
    packet['pair_id'] = 'atomic-original-native-fixture'
    packet['source_tables'] = {}
    objects = ImmutableNativeObjects(Bucket())
    packet['initial_state_objects'] = {arm: objects.put(state) for arm, state in args['states'].items()}
    if missing_models:
        packet.pop('model_prediction_arms')
        packet.pop('model_prediction_arms_checksum')
    sealed = freeze_snapshot(signal_date='2026-09-04', source_run_id=packet['pair_id'],
        snapshot_kind='execution_pair', content=packet, query=db.query, writer=db.writer,
        now=datetime(2026, 9, 4, 14, tzinfo=timezone.utc))
    args.update(query=db.query, writer=db.writer, snapshot_id=sealed['snapshot_id'])
    return db, args, objects, packet


def test_atomic_collector_requires_arm_capture_before_any_private_execution(native_runner):
    db, args, objects, packet = atomic_fixture(native_runner)
    with pytest.raises(ValueError, match='arm_capture_required'):
        collect_frame(snapshot_id=args['snapshot_id'], frame_index=0, objects=objects, query=db.query,
            capture_source=NativeSourceCapture(objects=objects, domain_queries={}), runner=native_runner,
            now=datetime.fromisoformat(packet['schedule'][0]['observed_at']))
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    assert objects.lookup_delivery(digest(frame_identity(args['snapshot_id'], packet['schedule'][0]))) is None


def test_atomic_collector_scoped_inputs_retry_identically_without_nav_credit(native_runner):
    db, args, objects, packet = atomic_fixture(native_runner)
    packet['source_context'] = {'variables': packet['variables'], 'frozen_kv': {}}
    source = capture(packet, objects)
    kwargs = dict(snapshot_id=args['snapshot_id'], frame_index=0, objects=objects, query=db.query,
        capture_source=source, runner=native_runner,
        now=datetime.fromisoformat(packet['schedule'][0]['observed_at']))
    first = collect_frame(**kwargs)
    assert collect_frame(**kwargs) == first
    assert first['states']['baseline'] == first['states']['candidate']
    assert first['session_complete'] is False and first['nav_maturity_credit'] == 0
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []


def test_atomic_full_cash_session_reconciles_and_materializes_once(native_runner):
    db, args, _, packet = atomic_fixture(native_runner)
    first = run_paired_session(**args)
    again = run_paired_session(**args)
    assert first['receipt_snapshot_id'] == again['receipt_snapshot_id']
    assert first['states'] == again['states']
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
    kwargs = dict(business_date='2026-09-07', query=db.query, writer=db.writer, now=args['now'])
    assert mature_staged_pairs(**kwargs)['processed_pair_sessions'] == 1
    journal = json.loads(db.query('SELECT payload_json FROM paired_nav_daily_journal_v1', [])[0]['payload_json'])
    assert journal['net_return_delta'] == 0
    assert journal['arms']['baseline']['nav'] == journal['arms']['candidate']['nav'] == 99000
    assert journal['promotion_allowed'] is False and journal['ev_prediction_dates_added'] == 0
    assert mature_staged_pairs(**kwargs)['processed_pair_sessions'] == 0


def test_atomic_session_missing_model_arms_is_rejected_before_replay(native_runner):
    db, args, _, _ = atomic_fixture(native_runner, missing_models=True)
    with pytest.raises(ValueError, match='arm_predictions_required'):
        run_paired_session(**args)
    assert db.query("SELECT * FROM paired_nav_frozen_manifests_v1 WHERE snapshot_kind='execution_receipt'", []) == []
    assert db.query('SELECT * FROM paired_nav_daily_journal_v1', []) == []
