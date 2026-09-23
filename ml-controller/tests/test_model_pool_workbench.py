"""Workbench must share observations without weakening serving-source checks."""
import asyncio
from copy import deepcopy

import pytest

from routers import model_pool
from services.verified_read_observation import observed_read


@pytest.mark.parametrize('drift', [False, True])
@pytest.mark.parametrize('overview_unavailable', [False, True])
def test_workbench_checks_shared_sources_before_return(monkeypatch, drift, overview_unavailable):
    rows = [{'artifact_id': 'active', 'eligible': True, 'future_column': None}]
    calls = []

    def fetch():
        calls.append(1)
        return deepcopy(rows)

    def reader():
        return observed_read('registry', 'SELECT * FROM registry', fetch)

    for name in ('_lineage_snapshot', '_artifact_registry_selection_snapshot',
                 '_artifact_registry_promotion_queue_snapshot',
                 '_artifact_registry_champion_pointers_snapshot'):
        monkeypatch.setattr(model_pool, name, reader)

    def overview():
        result = reader()
        assert len(calls) == 1
        if drift:
            rows[0]['future_column'] = 'revoked'
        if overview_unavailable:
            raise TimeoutError('private service detail')
        return result

    monkeypatch.setattr(model_pool, 'model_pool_overview', overview)
    if drift:
        with pytest.raises(RuntimeError, match='observation_changed'):
            asyncio.run(model_pool.workbench())
    else:
        result = asyncio.run(model_pool.workbench())
        assert result['status'] == 'ok'
        for key in ('lineage', 'selection', 'promotion_queue', 'champion_pointers'):
            assert result[key] == rows
        assert result['overview'] == (None if overview_unavailable else rows)
        result['lineage'][0]['eligible'] = False
        assert result['selection'][0]['eligible'] is True
    assert len(calls) == 2
    # Observation state must not survive the response.
    reader()
    assert len(calls) == 3


def test_authoritative_builder_failure_is_not_hidden(monkeypatch):
    def unavailable():
        raise TimeoutError('registry unavailable')
    monkeypatch.setattr(model_pool, '_lineage_snapshot', unavailable)
    with pytest.raises(TimeoutError):
        asyncio.run(model_pool.workbench())


def test_nested_overview_reuses_only_current_request_connection(monkeypatch):
    from services import d1_client
    class Client:
        created = 0
        closed = 0
        def __init__(self): Client.created += 1
        def __enter__(self): return self
        def __exit__(self, *args): Client.closed += 1
    monkeypatch.setattr(d1_client.httpx, 'Client', Client)
    with d1_client.read_connection_scope():
        first = d1_client._READ_HTTP.get()
        with d1_client.read_connection_scope():
            assert d1_client._READ_HTTP.get() is first
        assert Client.closed == 0
    assert Client.created == Client.closed == 1
    assert d1_client._READ_HTTP.get() is None
    with d1_client.read_connection_scope():
        assert d1_client._READ_HTTP.get() is not first
    assert Client.created == Client.closed == 2
