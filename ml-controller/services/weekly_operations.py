"""Durable weekly operations: no heavy work inside the dispatch HTTP request."""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
from datetime import datetime
from zoneinfo import ZoneInfo

from services.d1_domain_client import client_for_domain
from services.l4_replan_lease import replan_claim

TASKS = {"weekly-audit", "model-ic-full-check"}


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class StepReceipts:
    def __init__(self, task, run_date, identity):
        from google.cloud import storage
        bucket = os.environ.get("GCS_BUCKET_NAME", "").strip()
        if not bucket:
            raise RuntimeError("weekly_operations_receipt_bucket_missing")
        self.bucket = storage.Client().bucket(bucket)
        self.prefix = f"weekly-operations/v1/{task}/{run_date}/{digest(identity)}/"

    def read(self, step):
        from google.api_core.exceptions import NotFound
        try:
            value = json.loads(self.bucket.blob(self.prefix + step + '.json').download_as_bytes())
        except NotFound:
            return None
        if value.get("checksum") != digest(value.get("result")):
            raise RuntimeError("weekly_operations_receipt_checksum_mismatch")
        return value["result"]

    def save(self, step, result):
        from google.api_core.exceptions import PreconditionFailed
        blob = self.bucket.blob(self.prefix + step + '.json')
        try:
            blob.upload_from_string(json.dumps({"result": result, "checksum": digest(result)}, ensure_ascii=False),
                                    content_type='application/json', if_generation_match=0)
        except PreconditionFailed:
            pass
        if self.read(step) != result:
            raise RuntimeError("weekly_operations_receipt_readback_mismatch")


async def checkpoint(store, step, fn, fence):
    old = await asyncio.to_thread(store.read, step)
    if old is not None:
        return old
    await asyncio.to_thread(fence)
    result = await fn()
    if not isinstance(result, dict) or result.get('status') in ('error', 'failed'):
        raise RuntimeError(f"weekly_operations_step_failed:{step}:{result}")
    await asyncio.to_thread(fence)
    await asyncio.to_thread(store.save, step, result)
    return result


async def run_weekly_operations(task: str, run_date: str) -> dict:
    if task not in TASKS:
        raise ValueError('weekly_operations_task_invalid')
    datetime.strptime(run_date, '%Y-%m-%d')
    db = client_for_domain('ops')
    identity = {'contract': 'weekly-operations-v1', 'task': task, 'run_date': run_date}
    if task == 'model-ic-full-check':
        from services.model_serving_resolver import load_d1_champion_pool
        pool = await asyncio.to_thread(load_d1_champion_pool)
        identity['champions'] = {name: {key: value.get(key) for key in
            ('version', 'serving_artifact_id', 'checksum')} for name, value in (pool.get('models') or {}).items()}

    store = StepReceipts(task, run_date, identity)
    with replan_claim(db, group=f'weekly-operations:{task}:{run_date}', task_name=task) as fence:
        if fence is None:
            raise RuntimeError('weekly_operations_owner_busy')
        if task == 'weekly-audit':
            async def audit():
                rows = await asyncio.to_thread(db.query,
                    'SELECT * FROM weekly_audit_reports WHERE report_date=?', [run_date])
                if rows and rows[0].get('report_text'):
                    return {'status':'success', 'report_date':run_date,
                            'report': rows[0]['report_text'], 'source':'existing_archive'}
                if run_date != datetime.now(ZoneInfo('Asia/Taipei')).date().isoformat():
                    raise RuntimeError('weekly_audit_historical_archive_missing')
                from graphs.weekly_audit_graph import generate_weekly_audit
                return await generate_weekly_audit()
            result = await checkpoint(store, 'audit', audit, fence)
            return {'status':'completed','summary':f"report verified date={run_date}", 'audit':result}
        from routers.model_pool import compute_weekly_ic, ComputeWeeklyICRequest, artifact_registry_promotion_queue
        from routers.config_pool import weekly_eval, WeeklyEvalRequest
        ic = await checkpoint(store, 'ic', lambda: compute_weekly_ic(ComputeWeeklyICRequest(
            run_date=run_date, lookback_days=35, min_samples=50, min_dates=10, append_history=True)), fence)
        queue = await checkpoint(store, 'promotion_queue', lambda: artifact_registry_promotion_queue(), fence)
        config = await checkpoint(store, 'config_eval', lambda: weekly_eval(WeeklyEvalRequest(apply=False, confirm=False), apply_query=None, lookback_query=None), fence)
        return {'status':'completed', 'summary':f"IC n_rows={ic.get('n_rows_total')} queue={len(queue.get('queue', []))} config={config.get('status')}",
                'ic':ic, 'promotion_queue':queue, 'config_eval':config}
