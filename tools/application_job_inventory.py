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

# Reviewed runtime settings that only the live Job template holds: the release
# rollout updates image/source env only, and a Job recreated from deploy defaults
# must still match. Readback only; acceptance fails on drift and never rewrites.
REVIEWED_JOB_RUNTIME = {
    # >1 day per D1 query exceeded the 50 MB response limit (7500) on the
    # 1280-day export. Unset is accepted: dataset_snapshot_job_main defaults to 1.
    'dataset-snapshot-export': {'env': {'DATASET_SNAPSHOT_CHUNK_DAYS': ('1', None)}},
    # Same value as deploy_ml_controller.sh OOF_MATERIALIZE_JOB_MEMORY default.
    'active8-oof-materialize': {'memory': '24Gi'},
}
# A reviewed env sourced from valueFrom (Secret/ConfigMap) is drift: its value is
# never read back here, so it must not pass as unset. Only this marker is recorded.
VALUE_FROM = '<valueFrom>'


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
        env_rows={r['name']:VALUE_FROM if 'valueFrom' in r else r.get('value') for r in c.get('env',[])}
        reviewed=REVIEWED_JOB_RUNTIME.get(name,{}).get('env',{})
        return name,{'image':c['image'],'source_sha':env_rows.get('STOCKVISION_SOURCE_SHA'),
                     'memory':((c.get('resources') or {}).get('limits') or {}).get('memory'),
                     'reviewed_env':{key:env_rows.get(key) for key in reviewed}}
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


def verify_runtime(live_jobs):
    """Reviewed GCP-only settings read back from the live templates (JOBSPEC-1106)."""
    for name, spec in REVIEWED_JOB_RUNTIME.items():
        row = live_jobs.get(name) or {}
        if 'memory' in spec and row.get('memory') != spec['memory']:
            raise ValueError('application_job_runtime_drift:' + name + ':memory')
        for key, allowed in spec.get('env', {}).items():
            if (row.get('reviewed_env') or {}).get(key) not in allowed:
                raise ValueError('application_job_runtime_drift:' + name + ':' + key)


def verify_inventory(*, controller_env, live_jobs, expected_image, expected_sha):
    """Live listing is independent of the release list; pass sanitized records."""
    verify_ownership(controller_env=controller_env,live_jobs=live_jobs,expected_image=expected_image)
    for name in application_jobs():
        row = live_jobs.get(name)
        if not row or row['image'] != expected_image or row['source_sha'] != expected_sha:
            raise ValueError('application_job_release_mismatch:' + name)
    verify_runtime(live_jobs)
    return {name: APPLICATION_JOBS[name] for name in application_jobs()}
