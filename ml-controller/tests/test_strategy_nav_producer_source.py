from types import SimpleNamespace
import pytest
from services.cloud_run_jobs_client import CloudRunJobsClient


@pytest.mark.parametrize('producer', ['a'*40, 'b'*40, ''])
def test_actual_job_template_source_must_match_without_forged_execution_override(producer):
    source = 'a'*40
    client = CloudRunJobsClient(project_id='test', region='test', job_name='nav')
    calls = []
    def get_job(**kw):
        calls.append(kw)
        return SimpleNamespace(template=SimpleNamespace(template=SimpleNamespace(containers=[
            SimpleNamespace(env=[SimpleNamespace(name='STOCKVISION_SOURCE_SHA', value=producer)])])))
    client._client = SimpleNamespace(get_job=get_job)
    if producer == source:
        client.verify_source_alignment(source)
    else:
        with pytest.raises(ValueError, match='producer_consumer_source_mismatch'):
            client.run_job({'STOCKVISION_SOURCE_SHA': source}, expected_source_sha=source)
    assert len(calls) == 1


def test_unknown_consumer_source_cannot_dispatch():
    client = CloudRunJobsClient(project_id='test', region='test', job_name='nav')
    with pytest.raises(ValueError, match='consumer_source_identity_missing'):
        client.run_job(expected_source_sha='')
