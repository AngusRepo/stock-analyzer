import importlib.util
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('inventory',Path(__file__).resolve().parents[2]/'tools/application_job_inventory.py')
inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)

def _reviewed(name):
    spec=inventory.REVIEWED_JOB_RUNTIME.get(name,{})
    return dict(memory=spec.get('memory'),reviewed_env={key:allowed[0] for key,allowed in spec.get('env',{}).items()})

def test_acceptance_discovers_omitted_live_consumers_independently():
    image='asia-east1-docker.pkg.dev/project/repo/ml-controller@sha256:abc'
    rows={name:dict(image=image,source_sha='a'*40,**_reviewed(name)) for name in inventory.application_jobs()}
    assert len(inventory.verify_inventory(controller_env={},live_jobs=rows,expected_image=image,expected_sha='a'*40))==10
    rows['forgotten-job']=dict(image=image,source_sha='a'*40)
    with pytest.raises(ValueError,match='unreviewed_application_job:forgotten-job'):
        inventory.verify_inventory(controller_env={},live_jobs=rows,expected_image=image,expected_sha='a'*40)
    rows.pop('forgotten-job')
    rows['screener-v2']['source_sha']='b'*40
    with pytest.raises(ValueError,match='release_mismatch:screener-v2'):
        inventory.verify_inventory(controller_env={},live_jobs=rows,expected_image=image,expected_sha='a'*40)

def test_configured_alternate_is_not_silently_ignored():
    with pytest.raises(ValueError,match='unreviewed_application_job:new-backtest'):
        inventory.verify_inventory(controller_env={'BACKTEST_RESEARCH_JOB_NAME':'new-backtest'},
            live_jobs={},expected_image='registry/ml-controller@sha256:abc',expected_sha='a'*40)

def test_unused_finlab_alias_requires_verified_modal_executor_and_cannot_hide_shared_job():
    env={'FINLAB_JOB_NAME':'finlab-v4-backfill','FINLAB_BACKFILL_EXECUTOR':'modal'}
    image='registry/ml-controller@sha256:abc'
    inventory.verify_ownership(controller_env=env,live_jobs={},expected_image=image)
    with pytest.raises(ValueError,match='unreviewed_application_job:finlab-v4-backfill'):
        inventory.verify_ownership(controller_env=env,live_jobs={'finlab-v4-backfill':{'image':image}},expected_image=image)
    with pytest.raises(ValueError,match='unreviewed_application_job:finlab-v4-backfill'):
        inventory.verify_ownership(controller_env={'FINLAB_JOB_NAME':'finlab-v4-backfill'},live_jobs={},expected_image=image)


def test_gcp_only_job_runtime_is_read_back_not_trusted():
    # JOBSPEC-1106: the two settings that live only in the Job templates.
    image='registry/ml-controller@sha256:abc'
    rows={name:dict(image=image,source_sha='a'*40,**_reviewed(name)) for name in inventory.application_jobs()}
    verify=lambda:inventory.verify_inventory(controller_env={},live_jobs=rows,expected_image=image,expected_sha='a'*40)
    assert inventory.REVIEWED_JOB_RUNTIME=={
        'dataset-snapshot-export':{'env':{'DATASET_SNAPSHOT_CHUNK_DAYS':('1',None)}},
        'active8-oof-materialize':{'memory':'24Gi'}}
    verify()
    rows['dataset-snapshot-export']['reviewed_env']['DATASET_SNAPSHOT_CHUNK_DAYS']=None
    verify()  # unset falls back to the one-day code default
    rows['dataset-snapshot-export']['reviewed_env']['DATASET_SNAPSHOT_CHUNK_DAYS']='3'
    with pytest.raises(ValueError,match='runtime_drift:dataset-snapshot-export:DATASET_SNAPSHOT_CHUNK_DAYS'):
        verify()
    rows['dataset-snapshot-export']['reviewed_env']['DATASET_SNAPSHOT_CHUNK_DAYS']='1'
    rows['active8-oof-materialize']['memory']='16Gi'
    with pytest.raises(ValueError,match='runtime_drift:active8-oof-materialize:memory'):
        verify()

def test_live_listing_reads_only_reviewed_runtime_fields():
    import json
    env=[{'name':'STOCKVISION_SOURCE_SHA','value':'a'*40},{'name':'DATASET_SNAPSHOT_CHUNK_DAYS','value':'1'},
         {'name':'UNREVIEWED_VALUE','value':'never-copied'}]
    template={'spec':{'template':{'spec':{'template':{'spec':{'containers':[
        {'image':'img','env':env,'resources':{'limits':{'cpu':'4','memory':'8Gi'}}}]}}}}}}
    def gc(*argv):
        if argv[:3]==('run','services','describe'):
            return json.dumps({'spec':{'template':{'spec':{'containers':[{'env':[]}]}}}})
        if argv[:3]==('run','jobs','list'):
            return json.dumps([{'metadata':{'name':'dataset-snapshot-export'}}])
        return json.dumps(template)
    _,jobs=inventory.read_live_inventory(gc,region='asia-east1',service='ml-controller')
    assert jobs=={'dataset-snapshot-export':{'image':'img','source_sha':'a'*40,'memory':'8Gi',
                                             'reviewed_env':{'DATASET_SNAPSHOT_CHUNK_DAYS':'1'}}}

def test_reviewed_env_from_value_from_is_drift_without_echoing_it():
    import json
    secret={'secretKeyRef':{'name':'chunk-days-secret','key':'latest'}}
    template={'spec':{'template':{'spec':{'template':{'spec':{'containers':[
        {'image':'img','env':[{'name':'DATASET_SNAPSHOT_CHUNK_DAYS','valueFrom':secret}],
         'resources':{'limits':{'memory':'8Gi'}}}]}}}}}}
    def gc(*argv):
        if argv[:3]==('run','services','describe'):
            return json.dumps({'spec':{'template':{'spec':{'containers':[{'env':[]}]}}}})
        if argv[:3]==('run','jobs','list'):
            return json.dumps([{'metadata':{'name':'dataset-snapshot-export'}}])
        return json.dumps(template)
    _,jobs=inventory.read_live_inventory(gc,region='asia-east1',service='ml-controller')
    assert jobs['dataset-snapshot-export']['reviewed_env']=={'DATASET_SNAPSHOT_CHUNK_DAYS':inventory.VALUE_FROM}
    rows={name:_reviewed(name) for name in inventory.REVIEWED_JOB_RUNTIME}
    rows['dataset-snapshot-export']=jobs['dataset-snapshot-export']
    with pytest.raises(ValueError) as raised:
        inventory.verify_runtime(rows)
    assert str(raised.value)=='application_job_runtime_drift:dataset-snapshot-export:DATASET_SNAPSHOT_CHUNK_DAYS'
    assert 'chunk-days-secret' not in json.dumps(jobs)

@pytest.mark.parametrize('path',['tools/release/release_rollout.py','tools/deploy_controller_modal_release.py'])
def test_rollouts_check_reviewed_runtime_before_any_job_update(path):
    # Drift must stop the release while every Job still runs the previous image, not at acceptance.
    source=(Path(__file__).resolve().parents[2]/path).read_text(encoding='utf-8')
    ownership=source.index('verify_ownership(controller_env=referenced, live_jobs=listed_jobs, expected_image=image)')
    runtime=source.index('verify_runtime(listed_jobs)')
    first_update=min(source.index(call) for call in ("gc('run', 'jobs', 'update'", "gc('run', 'services', 'update'",
                                                      "'-m', 'modal', 'deploy'"))
    assert ownership<runtime<first_update
    rows={name:_reviewed(name) for name in inventory.REVIEWED_JOB_RUNTIME}
    rows['active8-oof-materialize']['memory']='16Gi'
    with pytest.raises(ValueError,match='runtime_drift:active8-oof-materialize:memory'):
        inventory.verify_runtime(rows)
