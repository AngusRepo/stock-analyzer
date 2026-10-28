import pytest


@pytest.fixture(autouse=True)
def isolated_slate_artifacts(tmp_path):
    """New slate I/O is local in tests, including graph integration fixtures."""
    from services.pipeline_slate_artifacts import local_store
    with local_store(tmp_path / 'slates'):
        yield


@pytest.fixture
def kv_position_risk(monkeypatch):
    """K16a: the trading:risk_config position contract replay entries read from KV."""
    from services import position_risk_owner
    formal = position_risk_owner.formal_position_risk({'position': {
        'maxPerSector': 2, 'maxSingleNamePct': 0.25, 'correlationThreshold': 0.7, 'correlationWindow': 60}})
    monkeypatch.setattr(position_risk_owner, 'load_formal_position_risk', lambda **_: formal)
    return formal
