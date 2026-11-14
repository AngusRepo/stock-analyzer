"""activate_l4_policy reads the sealed L4 plans one plan per D1 request.

The full payload_json table outgrew a single D1 response (HTTP 500 on 2026-11-02, 49 plans, 128 MB).
"""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT / 'tools') not in sys.path:
    sys.path.insert(0, str(ROOT / 'tools'))

import activate_l4_policy  # noqa: E402


class FakePaper:
    def __init__(self, plans):
        self.plans, self.calls = plans, []

    def query(self, sql, params=None):
        self.calls.append((sql, params))
        if sql.startswith('SELECT plan_id FROM'):
            return [{'plan_id': plan_id} for plan_id in sorted(self.plans)]
        assert 'plan_id=?' in sql, 'payloads must never be read for the whole table'
        (plan_id,) = params
        return [{'plan_id': plan_id, 'payload_json': self.plans[plan_id]}]


def test_sealed_plans_match_the_whole_table_read_one_plan_at_a_time():
    paper = FakePaper({'b': '{"n":2}', 'a': '{"n":1}', 'c': '{"n":3}'})
    assert activate_l4_policy.sealed_plans(paper) == [
        {'plan_id': 'a', 'payload_json': '{"n":1}'},
        {'plan_id': 'b', 'payload_json': '{"n":2}'},
        {'plan_id': 'c', 'payload_json': '{"n":3}'}]
    assert [params for _, params in paper.calls] == [None, ['a'], ['b'], ['c']]


def test_sealed_plans_of_an_empty_account_is_empty():
    assert activate_l4_policy.sealed_plans(FakePaper({})) == []
