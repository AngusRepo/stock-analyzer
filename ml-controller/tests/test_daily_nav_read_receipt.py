from copy import deepcopy
from datetime import datetime, timezone
import json
import pytest
from services.daily_nav_read_receipt import run_with_receipt

NOW = datetime(2026, 9, 25, tzinfo=timezone.utc)
class Client:
    def __init__(self): self.rows = [{'id': 1, 'checksum': 'original'}]
    def query(self, sql, params=None): return deepcopy(self.rows)
class Store:
    def __init__(self): self.data = {}
    def read(self, key): return json.loads(self.data[key]) if key in self.data else None
    def write(self, key, raw): self.data[key] = raw


def test_only_identical_complete_read_set_reuses_and_new_source_runs_owner():
    client, store, calls = Client(), Store(), []
    def run(recorded):
        calls.append(1)
        rows = recorded.query('SELECT * FROM source ORDER BY id', [])
        return {'status': 'failed', 'accounting_status': 'up_to_date', 'open_pair_sessions': 0, 'journal_chain_verified': True, 'rows': rows, '_adoption_candidates': []}
    def invoke(): return run_with_receipt(business_date='2026-09-24', client=client, store=store, run=run, now=NOW)
    original = invoke()
    assert invoke() == original
    assert len(calls) == 1
    client.rows.append({'id': 2, 'checksum': 'new'})
    assert invoke()['rows'] == client.rows
    assert len(calls) == 2
    client.rows[0]['checksum'] = 'changed-with-same-row-count'
    assert invoke()['rows'] == client.rows
    assert len(calls) == 3


@pytest.mark.parametrize('extra', [{'error_type':'TimeoutError'}, {'_adoption_candidates':[{'owner':'l15_route'}]},
                                 {'failure':{'stage':'refresh'}}, {'journal_chain_verified':False}])
def test_uncertain_or_authority_producing_result_cannot_enter_cache(extra):
    client, store = Client(), Store()
    def run(recorded):
        recorded.query('SELECT * FROM source', [])
        return {'status':'up_to_date', 'open_pair_sessions':0, 'journal_chain_verified':True, **extra}
    run_with_receipt(business_date='2026-09-24', client=client, store=store, run=run, now=NOW)
    assert not store.data


def test_source_changes_during_owner_and_store_outage_never_hide_result():
    client, store = Client(), Store()
    def run(recorded):
        recorded.query('SELECT * FROM source', [])
        client.rows = []
        return {'status':'up_to_date', 'open_pair_sessions':0, 'journal_chain_verified':True}
    assert run_with_receipt(business_date='2026-09-24', client=client, store=store, run=run, now=NOW) == {'status':'up_to_date', 'open_pair_sessions':0, 'journal_chain_verified':True}
    assert not store.data


def test_current_business_date_does_not_reuse_time_sensitive_closure():
    client, store = Client(), Store()
    calls = []
    def run(recorded):
        calls.append(1)
        recorded.query('SELECT * FROM source', [])
        return {'status':'up_to_date', 'open_pair_sessions':0, 'journal_chain_verified':True}
    for _ in range(2):
        run_with_receipt(business_date='2026-09-25', client=client, store=store, run=run, now=NOW)
    assert len(calls) == 2 and not store.data


def test_expected_incomplete_comparison_is_preserved_not_promoted():
    client, store, calls = Client(), Store(), []
    def run(recorded):
        calls.append(1)
        recorded.query('SELECT * FROM source', [])
        return {'status':'failed', 'accounting_status':'awaiting_execution_pairs', 'open_pair_sessions':0,
            'journal_chain_verified':True, '_adoption_candidates':[{'decision':'PENDING'}],
            'failures':[{'stage':'original_source','reason':'nav_policy_original_allocation_missing','error_type':'ValueError'}]}
    for _ in range(2):
        result = run_with_receipt(business_date='2026-09-24', client=client, store=store, run=run, now=NOW)
        assert result['status'] == 'failed' and result['failures']
    assert len(calls) == 1


def test_open_session_never_reuses_even_on_the_next_calendar_day():
    client, store = Client(), Store()
    def run(recorded):
        recorded.query('SELECT * FROM source', [])
        return {'status':'awaiting_session_close', 'open_pair_sessions':1, 'journal_chain_verified':True}
    run_with_receipt(business_date='2026-09-24', client=client, store=store, run=run, now=NOW)
    assert not store.data
