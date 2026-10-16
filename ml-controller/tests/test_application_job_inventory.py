import importlib.util
from pathlib import Path
import pytest

spec=importlib.util.spec_from_file_location('inventory',Path(__file__).resolve().parents[2]/'tools/application_job_inventory.py')
inventory=importlib.util.module_from_spec(spec);spec.loader.exec_module(inventory)

def test_acceptance_discovers_omitted_live_consumers_independently():
    image='asia-east1-docker.pkg.dev/project/repo/ml-controller@sha256:abc'
    rows={name:dict(image=image,source_sha='a'*40) for name in inventory.application_jobs()}
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
