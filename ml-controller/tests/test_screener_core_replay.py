"""Actual captured SQL execution, synthetic fixtures only (not NAV returns)."""
from copy import deepcopy
from pathlib import Path
import re
import sqlite3

import pytest

from services.screener_core_replay import replay_core_upsert, materialize_atomic_core_domains


ROOT = Path(__file__).resolve().parents[2]


def fixture():
    schema = (ROOT / 'worker/domain-migrations/core/0001_core_baseline.sql').read_text(encoding='utf-8')
    table = re.search(r'CREATE TABLE IF NOT EXISTS daily_recommendations \([\s\S]*?\n\);', schema).group()
    owner = (ROOT / 'worker/src/lib/screenerSeedQuality.ts').read_text(encoding='utf-8')
    sql = re.search(r'export function buildScreenerSeedUpsertSql\(\): string \{\s*return `([\s\S]*?)`', owner).group(1)
    before = dict(schema_version='screener-core-before-write-v1', signal_date='2026-09-07',
        knowledge_scope='observed_before_seed_write_not_historical_asof', symbols=['2330','2317'],
        sequence=10, table_sql=table, stock_rows=[dict(id=i, symbol=s, name=s, sector='IC', market='TWSE')
            for i, s in enumerate(['2330', '2317'], 1)], daily_rows=[])
    def bind(symbol, score):
        return ['2026-09-07', symbol, symbol, symbol, 'IC', 1, score, 20, 18, 10, 100,
                'own seed', '[]', '{"original":true}', 'IC', 'LISTED', 'tradable', 1, 1]
    return before, sql, bind


def test_original_sql_keeps_ml_owned_fields_and_candidate_new_row_is_own():
    before, sql, bind = fixture()
    original = deepcopy(before)
    first = replay_core_upsert(before, sql, [bind('2330', 53)], observed_at='2026-09-07T12:00:00Z')
    assert before == original
    assert first[0]['id'] == 11 and first[0]['score'] == 53
    assert first[0]['created_at'] == '2026-09-07 12:00:00'
    first[0].update(signal='BUY', confidence=.8, ml_score=80, score=91,
        reason='ML reason', watch_points='["ML context"]', rank=3)
    before.update(sequence=11, daily_rows=deepcopy(first))
    baseline = replay_core_upsert(before, sql, [bind('2330', 48)], observed_at='2026-09-07T13:00:00Z')
    assert baseline[0]['score'] == 91 and baseline[0]['rank'] == 3
    assert baseline[0]['reason'] == 'ML reason' and baseline[0]['watch_points'] == '["ML context"]'
    candidate = replay_core_upsert(before, sql, [bind('2317', 48)], observed_at='2026-09-07T13:00:00Z')
    assert candidate[0]['score'] == 48 and candidate[0]['reason'] == 'own seed'
    assert candidate[0]['signal'] is None and candidate[0]['stock_id'] == 2
    assert baseline == replay_core_upsert(before, sql, [bind('2330', 48)], observed_at='2026-09-07T13:00:00Z')
    assert before['daily_rows'] == first


def test_empty_slate_does_not_retain_formal_picks():
    before, sql, bind = fixture()
    before['daily_rows'] = replay_core_upsert(before, sql, [bind('2330', 53)], observed_at='2026-09-07T12:00:00Z')
    before['sequence'] = 11
    assert replay_core_upsert(before, sql, [], observed_at='2026-09-07T12:00:00Z') == []


@pytest.mark.parametrize('attack', ['attach', 'extension', 'other_table', 'multiple_statements', 'cross_scope'])
def test_captured_sql_cannot_escape_memory_or_scope(attack):
    before, sql, bind = fixture()
    bindings = [bind('2330', 53)]
    if attack == 'attach':
        before['table_sql'] = "ATTACH DATABASE 'forbidden.db' AS external"
    elif attack == 'extension':
        before['table_sql'] = "SELECT load_extension('forbidden')"
    elif attack == 'other_table':
        before['table_sql'] = 'CREATE TABLE unrelated(secret TEXT)'
    elif attack == 'multiple_statements':
        sql += '; DROP TABLE stocks'
    else:
        bindings[0][1] = bindings[0][2] = '9999'
    with pytest.raises((sqlite3.Error, ValueError)):
        replay_core_upsert(before, sql, bindings, observed_at='2026-09-07T12:00:00Z')


def test_core_domain_consumer_checks_actual_formal_output_before_candidate():
    before, sql, bind = fixture()
    baseline_bindings = [bind('2330', 53)]
    actual = replay_core_upsert(before, sql, baseline_bindings, observed_at='2026-09-07T12:00:10Z')
    packet = dict(signal_date='2026-09-07', source_observed_at='2026-09-07T12:00:00Z',
        artifact_created_at='2026-09-07T13:00:00Z', core_seed_persistence=[dict(status='captured',
            started_at='2026-09-07T12:00:00Z', completed_at='2026-09-07T12:00:10Z', symbols=before['symbols'],
            value=dict(before=before, upsert_sql=sql, baseline_bindings=baseline_bindings))],
        replacements=[dict(definition_checksum='a'*64, candidate=dict(status='materialized',
            rows=[dict(seed=dict(row=dict(symbol='2317')))]), core_upsert_bindings=[bind('2317', 48)])])
    context = dict(content_checksum='b'*64, inputs=dict(daily_rows=actual))
    result = materialize_atomic_core_domains(packet, context)
    assert result['definitions']['a'*64]['daily_rows'][0]['symbol'] == '2317'
    assert result['nav_maturity_credit'] == 0 and result['promotion_allowed'] is False
    context['inputs']['daily_rows'][0]['score'] = 999
    with pytest.raises(ValueError, match='incumbent_persistence_mismatch'):
        materialize_atomic_core_domains(packet, context)


def test_missing_before_state_is_not_assumed_empty():
    assert materialize_atomic_core_domains({}, {})['reason'] == 'core_pre_write_source_not_captured'
