"""Read-only inventory of Modal apps that outlive their one-off purpose (2026-10-30).

Two `modal run --detach` repair apps crash-looped for two weeks unnoticed, and
129 one-off runs reused the `stockvision-ml` name so billing could not tell them
apart. The HMM maintenance tick (TW 14:00 and 20:00, twice a day, holidays
included) calls start_background(); it lists the workspace's apps and flags
ephemeral/detached apps alive longer than 24 h or running under a deployed
app's name. The tick's response never waits for it.

Read-only: it never stops, runs or deploys anything. The alert is an ops
`system_logs` warn row plus a logging warning; no Discord / webhook channel.
AppList carries no container failure counts, so a crash loop is caught by age.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
from datetime import datetime, timezone
from typing import Any, Callable

logger = logging.getLogger(__name__)

CRON_NAME = 'modal-app-inventory'
MAX_EPHEMERAL_AGE_HOURS = 24.0
INVENTORY_TIMEOUT_SEC = 15.0
EPHEMERAL_STATES = frozenset({'ephemeral', 'detached', 'detached_disconnected'})


def list_modal_apps() -> list[dict[str, Any]]:
    """Blocking AppList call, the same RPC `modal app list` uses (no public SDK
    lister in the pinned modal 1.4; 1.6 adds Environment.apps.list but drops state)."""
    from modal._object import _get_environment_name
    from modal._utils.async_utils import synchronizer
    from modal.client import _Client
    from modal_proto import api_pb2

    @synchronizer.create_blocking
    async def _list() -> list[Any]:
        client = await _Client.from_env()
        response = await client._stub.AppList(
            api_pb2.AppListRequest(environment_name=_get_environment_name(None)))
        return list(response.apps)

    return [{
        'app_id': item.app_id,
        'name': item.name or item.description,
        'state': state_name(api_pb2.AppState, item.state),
        'created_at': float(item.created_at or 0),
        'tasks': int(item.n_running_tasks),
    } for item in _list()]


def state_name(enum: Any, value: int) -> str:
    """'APP_STATE_DETACHED' -> 'detached'; an enum value newer than the SDK -> 'unknown_<n>'."""
    try:
        return enum.Name(value).removeprefix('APP_STATE_').lower()
    except ValueError:
        return f'unknown_{value}'


def evaluate_apps(apps: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    """Flag each live ephemeral/detached app that is too old or reuses a deployed name."""
    deployed = {app['name'] for app in apps if app['state'] == 'deployed'}
    flagged = []
    for app in apps:
        if app['state'] not in EPHEMERAL_STATES:
            continue
        created = datetime.fromtimestamp(app['created_at'], timezone.utc) if app['created_at'] else None
        age_hours = (now - created).total_seconds() / 3600 if created else None
        reasons = []
        if age_hours is None or age_hours > MAX_EPHEMERAL_AGE_HOURS:
            reasons.append('alive_over_24h')
        if app['name'] in deployed:
            reasons.append('deployed_name_reuse')
        if reasons:
            flagged.append({
                'app_id': app['app_id'], 'name': app['name'], 'state': app['state'],
                'age_hours': round(age_hours, 1) if age_hours is not None else None,
                'created_at': created.isoformat() if created else None,
                'tasks': app['tasks'], 'reasons': reasons,
            })
    return flagged


def _write_system_log(level: str, message: str, meta: dict[str, Any]) -> None:
    """One ops system_logs row, same shape as the Worker's writeSystemLog (SystemStatusBar
    reads it). A single attempt: the retrying D1 client could land duplicate warn rows."""
    import httpx
    from services import d1_client
    from services.allocator_contract_guard import allocator_contract_guard_enabled
    from services.d1_domain_client import D1DataDomain, database_id_for_domain
    if allocator_contract_guard_enabled():  # the same no-write guard DomainD1Client honours
        return
    if not d1_client.CF_ACCOUNT_ID or not d1_client.CF_API_TOKEN:
        raise RuntimeError('system_logs insert skipped: CF env unset')
    url = (f'https://api.cloudflare.com/client/v4/accounts/{d1_client.CF_ACCOUNT_ID}'
           f'/d1/database/{database_id_for_domain(D1DataDomain.OPS)}/query')
    response = httpx.post(url, timeout=10.0, headers={'Authorization': f'Bearer {d1_client.CF_API_TOKEN}'}, json={
        'sql': "INSERT INTO system_logs (level, cron_name, message, meta, created_at) "
               "VALUES (?, ?, ?, ?, datetime('now'))",
        'params': [level, CRON_NAME, message, json.dumps(meta)],
    })
    if response.status_code != 200 or not response.json().get('success'):
        raise RuntimeError(f'system_logs insert failed: HTTP {response.status_code}')


def run_inventory(
    *,
    lister: Callable[[], list[dict[str, Any]]] | None = None,
    log_writer: Callable[[str, str, dict[str, Any]], None] | None = None,
    now: datetime | None = None,
) -> dict[str, Any]:
    """List, evaluate and alert. A failing system log never hides the logging warning."""
    apps = (lister or list_modal_apps)()
    flagged = evaluate_apps(apps, now or datetime.now(timezone.utc))
    summary = {'status': 'alert' if flagged else 'ok', 'apps': len(apps), 'flagged': flagged}
    if flagged:
        message = (f'{len(flagged)} Modal ephemeral app(s) need a stop: '
                   + ', '.join(f"{a['name']}({a['app_id']}) {a['state']} {a['age_hours']}h "
                               f"tasks={a['tasks']} {'+'.join(a['reasons'])}" for a in flagged))
        logger.warning('[modal_app_inventory] %s', message)
        try:
            (log_writer or _write_system_log)('warn', message, summary)
        except Exception as exc:  # noqa: BLE001 - the logging warning above is the floor.
            logger.warning('[modal_app_inventory] system_logs write failed: %s', exc)
    else:
        logger.info('[modal_app_inventory] ok apps=%s', len(apps))
    return summary


async def run_inventory_alert() -> dict[str, Any]:
    """Async entry for the maintenance tick; skipped where the process has no Modal token."""
    if not os.environ.get('MODAL_TOKEN_ID'):
        return {'status': 'skipped', 'reason': 'modal_token_unset'}
    return await asyncio.to_thread(run_inventory)


_BACKGROUND: set[asyncio.Task] = set()


async def _bounded_inventory() -> dict[str, Any]:
    try:
        return await asyncio.wait_for(run_inventory_alert(), INVENTORY_TIMEOUT_SEC)
    except Exception as exc:  # noqa: BLE001 - ops telemetry never fails its host.
        # A timed-out AppList thread cannot be cancelled; it may still finish and log later.
        logger.warning('[modal_app_inventory] inventory failed (non-fatal): %r', exc)
        return {'status': 'failed', 'error': type(exc).__name__}


def start_background() -> asyncio.Task | None:
    """Fire-and-forget inventory on the running loop; at most one in flight. The set keeps
    a reference so the task is not garbage-collected before it ends."""
    if _BACKGROUND:
        return None
    task = asyncio.get_running_loop().create_task(_bounded_inventory())
    _BACKGROUND.add(task)
    task.add_done_callback(_BACKGROUND.discard)
    return task
