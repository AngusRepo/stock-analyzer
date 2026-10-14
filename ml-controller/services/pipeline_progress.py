"""Best-effort phase telemetry; never controls continuation or trading decisions."""
from contextlib import asynccontextmanager
from datetime import datetime, timezone
import logging
import os
import time

import httpx

_started = None
_completed = []


def node_result_status(name, update):
    """Reflect explicit shadow/sidecar outcomes without changing graph control."""
    key = {'node_capture_atomic_inputs': 'paired_nav_atomic_inputs',
           'node_l2_timesfm_enrich': 'timesfm_l2_summary'}.get(name)
    result = update.get(key) if key and isinstance(update, dict) else None
    status = result.get('status') if isinstance(result, dict) else None
    return 'blocked' if status == 'blocked' else 'failed' if status in ('failed', 'error') else 'completed'


def completed(name, elapsed_ms, *, status='completed'):
    _completed.append({'phase': name, 'elapsed_ms': round(elapsed_ms), 'status': status})


async def report(phase, *, status='running', phase_started_at=None):
    global _started
    run_id = os.environ.get('PIPELINE_PARENT_RUN_ID') or os.environ.get('CLOUD_RUN_EXECUTION')
    run_date = os.environ.get('PIPELINE_RUN_DATE')
    url = os.environ.get('STOCKVISION_WORKER_URL', '').rstrip('/')
    token = os.environ.get('STOCKVISION_AUTH_TOKEN')
    if not all((run_id, run_date, url, token)) or os.environ.get('STOCKVISION_NOOP_CALLBACK') == '1':
        return
    now = datetime.now(timezone.utc).isoformat()
    _started = _started or phase_started_at or now
    payload = {'task': 'pipeline-progress', 'status': 'running', 'run_id': run_id, 'run_date': run_date,
        'progress': {'phase': phase, 'status': status, 'started_at': _started,
            'phase_started_at': phase_started_at or now, 'observed_at': now,
            'execution_id': os.environ.get('CLOUD_RUN_EXECUTION', ''), 'completed': _completed[-32:]}}
    try:
        async with httpx.AsyncClient(timeout=3) as client:
            response = await client.post(url + '/api/admin/scheduler-callback', json=payload,
                headers={'Authorization': 'Bearer ' + token})
            response.raise_for_status()
    except Exception as exc:
        # Do not log provider URLs/tokens. Telemetry outage cannot fail inference.
        logging.getLogger(__name__).warning('Pipeline progress unavailable: %s', type(exc).__name__)


@asynccontextmanager
async def phase(name, *, deferred_exception=()):
    started_at = datetime.now(timezone.utc).isoformat()
    await report(name, phase_started_at=started_at)
    started = time.monotonic()
    outcome = {'status': 'completed'}
    try:
        yield outcome
    except BaseException as exc:
        outcome['status'] = 'blocked' if isinstance(exc, deferred_exception) else 'failed'
        raise
    finally:
        status = outcome['status']
        completed(name, (time.monotonic()-started)*1000, status=status)
        await report(name, status=status, phase_started_at=started_at)
