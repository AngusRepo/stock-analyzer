"""Reviewed shared-image ownership and independent live-reference acceptance.

No provider mutations. Release callers use application_jobs(); acceptance also
checks the live Controller's references and all shared-image Job templates.
"""
from __future__ import annotations

APPLICATION_JOBS = {
    'pipeline-v2': 'active',
    'active8-oof-materialize': 'active',
    'l4-distribution-refresh': 'active',
    'verify-v2': 'active',
    'dataset-snapshot-export': 'active',
    'optuna-research-sweep': 'active',
    'weekly-backtest-research': 'active',
    'screener-v2': 'active',
    's12-structure-batch': 'research',
    'strategy-mining-research': 'alternate',
}


def application_jobs():
    return tuple(APPLICATION_JOBS)


def read_live_inventory(gc, *, region, service):
    """List every Job first, including consumers omitted from the release list."""
    import json
    from concurrent.futures import ThreadPoolExecutor
    controller=json.loads(gc('run','services','describe',service,'--region='+region,'--format=json'))
    env={r['name']:r.get('value','') for r in controller['spec']['template']['spec']['containers'][0].get('env',[])
         if r['name'].endswith('_JOB_NAME') or r['name']=='FINLAB_BACKFILL_EXECUTOR'}
    listed=json.loads(gc('run','jobs','list','--region='+region,'--format=json'))
    def describe(row):
        name=row['metadata']['name']
        job=json.loads(gc('run','jobs','describe',name,'--region='+region,'--format=json'))
        containers=job['spec']['template']['spec']['template']['spec']['containers']
        if len(containers)!=1: raise ValueError('unreviewed_job_containers:'+name)
        c=containers[0]
        return name,{'image':c['image'],'source_sha':next((r.get('value') for r in c.get('env',[]) if r['name']=='STOCKVISION_SOURCE_SHA'),None)}
    with ThreadPoolExecutor(max_workers=4) as pool:
        return env,dict(pool.map(describe,listed))


def verify_ownership(*, controller_env, live_jobs, expected_image):
    # routers/finlab.py requires Modal and never reads the retained legacy
    # FINLAB_JOB_NAME. Do not mistake that unused value for a Cloud Run consumer.
    legacy_finlab = (controller_env.get('FINLAB_BACKFILL_EXECUTOR')=='modal'
                     and controller_env.get('FINLAB_JOB_NAME')=='finlab-v4-backfill')
    configured = {value for key, value in controller_env.items()
                  if key.endswith('_JOB_NAME') and value and not (key=='FINLAB_JOB_NAME' and legacy_finlab)}
    image_family = expected_image.split('@')[0].split(':')[0]
    shared = {name for name, row in live_jobs.items()
              if row['image'].split('@')[0].split(':')[0] == image_family}
    missing = (configured | shared) - APPLICATION_JOBS.keys()
    if missing:
        raise ValueError('unreviewed_application_job:' + ','.join(sorted(missing)))


def verify_inventory(*, controller_env, live_jobs, expected_image, expected_sha):
    """Live listing is independent of the release list; pass sanitized records."""
    verify_ownership(controller_env=controller_env,live_jobs=live_jobs,expected_image=expected_image)
    for name in application_jobs():
        row = live_jobs.get(name)
        if not row or row['image'] != expected_image or row['source_sha'] != expected_sha:
            raise ValueError('application_job_release_mismatch:' + name)
    return {name: APPLICATION_JOBS[name] for name in application_jobs()}
