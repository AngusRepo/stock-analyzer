from types import SimpleNamespace
import asyncio
import pytest

from services.pipeline_runtime_preflight import validate_modal_provenance, verify_pipeline_runtime


def provenance(source='a'*40):
    return {'schema_version': 'stockvision-modal-deployment-provenance-v1', 'source_sha': source}


def test_exact_source_contract_preserved():
    assert validate_modal_provenance(provenance(), 'a'*40)['status'] == 'verified'
    with pytest.raises(ValueError, match='source_sha_mismatch'):
        validate_modal_provenance(provenance('b'*40), 'a'*40)
    with pytest.raises(ValueError, match='provenance_invalid'):
        validate_modal_provenance({}, 'a'*40)


def test_read_only_metadata_function_before_compute(monkeypatch):
    import modal
    seen=[]
    async def read():
        seen.append('metadata')
        return provenance()
    def lookup(app, name):
        assert (app,name)==('stockvision-ml','deployment_provenance')
        return SimpleNamespace(remote=SimpleNamespace(aio=read))
    monkeypatch.setattr(modal.Function,'from_name',lookup)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    assert asyncio.run(verify_pipeline_runtime())['modal_source_sha']=='a'*40
    assert seen==['metadata']



def test_slow_metadata_read_fails_before_compute(monkeypatch):
    import modal
    import services.pipeline_runtime_preflight as preflight
    async def read():
        await asyncio.sleep(1)
    monkeypatch.setattr(modal.Function,'from_name',lambda app,name: SimpleNamespace(remote=SimpleNamespace(aio=read)))
    monkeypatch.setattr(preflight,'PROVENANCE_TIMEOUT_SECONDS',0.01)
    monkeypatch.setenv('STOCKVISION_SOURCE_SHA','a'*40)
    with pytest.raises(ValueError, match='^pipeline_modal_provenance_timeout_before_compute$'):
        asyncio.run(verify_pipeline_runtime())


def test_runner_mismatch_stops_before_any_data_or_model_work(monkeypatch):
    from graphs import daily_pipeline_v2 as graph
    import services.pipeline_runtime_preflight as preflight
    async def reject():
        raise ValueError('pipeline_modal_source_sha_mismatch')
    async def forbidden(*args,**kwargs):
        pytest.fail('expensive stage ran before runtime parity')
    monkeypatch.setattr(preflight,'verify_pipeline_runtime',reject)
    monkeypatch.setattr(graph,'_run_pipeline_nodes',forbidden)
    result=asyncio.run(graph.run_pipeline_v2_until_modal_prediction_spawn('2026-10-15','run'))
    assert result['status']=='error' and 'source_sha_mismatch' in result['error']
