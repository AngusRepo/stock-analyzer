import pytest


@pytest.fixture(autouse=True)
def isolated_slate_artifacts(tmp_path):
    """New slate I/O is local in tests, including graph integration fixtures."""
    from services.pipeline_slate_artifacts import local_store
    with local_store(tmp_path / 'slates'):
        yield


@pytest.fixture(autouse=True)
def no_archived_predictions(monkeypatch):
    """Ops D1 holds no archived predictions chunk unless a test injects one (L-2 cold reads)."""
    from services import retention_history

    class _NoArchives:
        @staticmethod
        def query(sql, params=None, **_):
            if 'FROM run_artifacts' in sql:
                return []
            raise AssertionError('unexpected ops query in tests: ' + sql[:80])

    monkeypatch.setattr(retention_history, 'OPS', _NoArchives())


@pytest.fixture
def kv_position_risk(monkeypatch):
    """K16a: the trading:risk_config position contract replay entries read from KV."""
    from services import position_risk_owner
    formal = position_risk_owner.formal_position_risk({'position': {
        'maxPerSector': 2, 'maxSingleNamePct': 0.25, 'correlationThreshold': 0.7, 'correlationWindow': 60,
        'minCorrelationOverlap': 20}})
    monkeypatch.setattr(position_risk_owner, 'load_formal_position_risk', lambda **_: formal)
    return formal
