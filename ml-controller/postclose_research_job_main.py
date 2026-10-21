"""GCP Scheduler -> Cloud Run Job dispatcher; no Cloudflare cron dependency."""
from datetime import datetime, timezone, timedelta, date
import json
import os


def run(*, trade_date=None, jobs_client=None, storage_client=None, now=None):
    from services.cloud_run_jobs_client import CloudRunJobsClient
    from services.premarket_postclose import dispatch_day
    now = now or datetime.now(timezone.utc)
    if now.tzinfo is None:
        raise ValueError('postclose_job_timezone_missing')
    day = trade_date or os.environ.get('POSTCLOSE_TRADE_DATE') or now.astimezone(
        timezone(timedelta(hours=8))).date().isoformat()
    if date.fromisoformat(day).isoformat()!=day:
        raise ValueError('postclose_job_date_invalid')
    name = os.environ.get('DATASET_SNAPSHOT_JOB_NAME') or os.environ.get('PIPELINE_DATASET_SNAPSHOT_JOB_NAME')
    if jobs_client is None:
        if not name:
            raise ValueError('postclose_target_job_missing')
        jobs_client = CloudRunJobsClient(job_name=name,require_source_alignment=True)
    result = dispatch_day(day,jobs_client=jobs_client,client=storage_client,now=now)
    if result['status'] in ('error','reconciliation_required'):
        raise RuntimeError('postclose_dispatch_not_complete:'+result['status'])
    return result


if __name__=='__main__':
    print(json.dumps(run(),sort_keys=True))
