import importlib.util
import re
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]


def _tool():
    spec = importlib.util.spec_from_file_location('momentum_pool_backfill', REPO / 'tools/momentum_pool_definition_backfill.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_pool_definition_matches_the_worker_constant():
    source = (REPO / 'worker/src/lib/momentumZone.ts').read_text(encoding='utf-8')
    worker = re.search(r"export const MOMENTUM_POOL_DEFINITION = '([^']+)'", source).group(1)
    assert _tool().POOL_DEFINITION == worker


def test_proposal_stops_at_the_last_pool_size_change():
    rows = ([{'date': f'2026-01-{d:02d}', 'candidate_count': 640, 'pool_definition': None} for d in range(1, 11)]
            + [{'date': f'2026-02-{d:02d}', 'candidate_count': 25 + d % 3, 'pool_definition': None} for d in range(1, 21)])
    result = _tool().propose(rows)
    assert result['proposed_since'] == '2026-02-01'
    assert result['first_excluded'] == '2026-01-10'
    assert result['run_rows'] == 20 and result['null_rows'] == 30


class _Market:
    def __init__(self, rows):
        self.rows, self.writes = rows, []

    def query(self, sql, params=None):
        return [dict(r) for r in self.rows]

    def execute(self, sql, params):
        self.writes.append((sql, params))
        for row in self.rows:
            if row['pool_definition'] is None and row['date'] >= params[1]:
                row['pool_definition'] = params[0]


@pytest.fixture
def market(monkeypatch):
    import services.d1_domain_client as client
    fake = _Market([{'date': '2026-02-01', 'candidate_count': 25, 'pool_definition': None},
                    {'date': '2026-02-02', 'candidate_count': 26, 'pool_definition': None}])
    monkeypatch.setattr(client, 'client_for_domain', lambda domain: fake if domain == 'market' else None)
    return fake


def test_dry_run_never_writes(market):
    assert _tool().main([])['proposed_since'] == '2026-02-01'
    assert market.writes == []


def test_execute_needs_an_explicit_since(market):
    with pytest.raises(SystemExit):
        _tool().main(['--execute'])
    assert market.writes == []


def test_execute_labels_only_null_rows_since_and_reads_back(market):
    result = _tool().main(['--execute', '--since', '2026-02-02'])
    assert market.writes[0][1] == ['screener-v2.final-candidates.v1', '2026-02-02']
    assert 'pool_definition IS NULL' in market.writes[0][0]
    assert [r['pool_definition'] for r in market.rows] == [None, 'screener-v2.final-candidates.v1']
    assert result['after']['labelled_rows'] == 1


def test_proposal_is_empty_on_the_day_the_pool_changes():
    rows = ([{'date': f'2026-02-{d:02d}', 'candidate_count': 25, 'pool_definition': None} for d in range(1, 21)]
            + [{'date': '2026-02-21', 'candidate_count': 640, 'pool_definition': None}])
    assert _tool().propose(rows)['proposed_since'] is None


def test_execute_fails_when_the_readback_still_has_null_rows(market):
    market.execute = lambda sql, params: market.writes.append((sql, params))  # the write is lost
    with pytest.raises(SystemExit, match='still NULL'):
        _tool().main(['--execute', '--since', '2026-02-01'])
