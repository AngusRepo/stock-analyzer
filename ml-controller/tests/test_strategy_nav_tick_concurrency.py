from copy import deepcopy
from datetime import datetime, timezone
import threading

import pytest
from services import paired_native_runtime as runtime, paired_native_prestart
from services.paired_native_session import session_schedule


def test_independent_pairs_are_bounded_concurrent_and_failure_keeps_full_ordered_census(monkeypatch):
    rows = [{'snapshot_id': f'{i:064x}'} for i in range(12)]
    gate, lock = threading.Event(), threading.Lock()
    counts = {'active': 0, 'peak': 0}
    visited = []
    def read(query, snapshot_id):
        with lock:
            counts['active'] += 1
            counts['peak'] = max(counts['peak'], counts['active'])
            visited.append(snapshot_id)
            if counts['active'] == 4:
                gate.set()
        assert gate.wait(2), 'comparison reads stayed serial'
        try:
            if snapshot_id == rows[3]['snapshot_id']:
                raise RuntimeError('native_fixture_source_unavailable')
            return {'manifest': {'signal_date':'2026-09-07'}, 'payload': {'content': {
                'owner':'opb_arm_prior', 'configuration':{}, 'session_date':'2026-09-08',
                'schedule':session_schedule('2026-09-08')}}}
        finally:
            with lock:
                counts['active'] -= 1
    monkeypatch.setattr(runtime, 'read_snapshot', read)
    monkeypatch.setattr(paired_native_prestart, 'succession', lambda *args, **kwargs: None)
    monkeypatch.setattr(paired_native_prestart, 'assert_collectible', lambda *args, **kwargs: None)
    class Objects:
        def lookup_delivery(self, key): return None
    result = runtime.collect_due_execution_frames(session_date='2026-09-08',
        query=lambda *args: deepcopy(rows), writer=lambda *args: pytest.fail('no due frame may write'),
        objects=Objects(), capture_factory=lambda **kwargs: pytest.fail('future source capture forbidden'),
        clock=lambda: datetime(2026,9,7,23,tzinfo=timezone.utc), parallelism=4)
    assert counts['peak'] == 4 and len(visited) == 12
    assert [r['snapshot_id'] for r in result['pairs']] == [r['snapshot_id'] for r in rows]
    assert result['status'] == 'failed' and result['pairs'][3]['reason'] == 'native_fixture_source_unavailable'
    assert all(r['completed_frames'] == 0 for r in result['pairs'])
    assert sum(r['status'] == 'collecting' for r in result['pairs']) == 11
    assert result['promotion_allowed'] is False and result['production_effect'] is False


@pytest.mark.parametrize('count',[0,5,True,1.5])
def test_invalid_concurrency_cannot_expand_runtime_workers(count):
    with pytest.raises(ValueError, match='parallelism_invalid'):
        runtime.collect_due_execution_frames(session_date='2026-09-08', query=None, writer=None,
            objects=None, capture_factory=None, parallelism=count)
