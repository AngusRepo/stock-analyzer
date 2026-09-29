from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
import json
import pytest

import oof_materialize_job_main as job
from services import paired_nav_read_cache as cache, strategy_nav_read_model as model, d1_domain_client


@pytest.mark.parametrize('source_changes', [False, True])
def test_daily_accounting_and_display_share_bounded_originals_but_recheck_all_sql(monkeypatch, source_changes):
    reads, scopes = [], []
    day = '2026-09-28'
    now = datetime(2026, 9, 29, tzinfo=timezone.utc)
    class Client:
        rows = [{'checksum': 'original'}]
        calls = 0
        def query(self, *args):
            self.calls += 1
            return deepcopy(self.rows)
    class Store:
        data = {}
        def read(self, key):
            return json.loads(self.data[key]) if key in self.data else None
        def write(self, key, value): self.data[key] = value
        def publish_latest(self, value): pass
    client, store = Client(), Store()
    def original():
        reads.append(1)
        return {'original_values': [1, 2, 3]}
    def accounting(**kwargs):
        scope = cache._scope.get()
        assert scope.max_bytes == 128 * 1024 * 1024
        scopes.append(scope.directory)
        value = cache.cached_verified_read(('original', 'checksum'), original)
        value['original_values'].append(999)  # A caller cannot corrupt the cached original.
        return {'as_of_date': day, 'status': 'awaiting_execution_pairs'}
    def display(*, business_date, query, now):
        assert cache._scope.get().directory == scopes[-1]
        assert cache.cached_verified_read(('original', 'checksum'), original) == {'original_values': [1, 2, 3]}
        query('SELECT checksum FROM original ORDER BY checksum', [])
        if source_changes:
            client.rows = [{'checksum': 'new-revision'}]
        return {'as_of_date': day, 'observed_at': now.isoformat(), 'entries': []}
    monkeypatch.setattr(job, '_execute_daily_nav_scoped', accounting)
    monkeypatch.setattr(model, 'code_identity', lambda: 'fixture')
    monkeypatch.setattr(model, 'production_read_store', lambda: store)
    monkeypatch.setattr(model, 'read_all_strategy_nav_evidence', display)
    monkeypatch.setattr(d1_domain_client, 'client_for_domain', lambda domain: client)
    result = job._execute_daily_nav(end_date=day, now=now, publish_strategy_display=True)
    assert reads == [1]
    assert client.calls == 2  # Complete producer read plus unchanged-source check.
    assert result['status'] == 'awaiting_execution_pairs'
    assert result['strategy_nav_read_model']['status'] == ('unavailable' if source_changes else 'published')
    assert bool(store.data) is not source_changes
    assert cache._scope.get() is None and not Path(scopes[0]).exists()
    # A new job must independently obtain originals again, even after failure.
    client.rows = [{'checksum': 'original'}]; store.data.clear()
    job._execute_daily_nav(end_date=day, now=now, publish_strategy_display=True)
    assert reads == [1, 1]
    assert all(not Path(path).exists() for path in scopes)
