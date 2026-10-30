"""Read-only inventory of Modal apps that outlive their one-off purpose (2026-10-30).

Two `modal run --detach` repair apps crash-looped for two weeks unnoticed, and
129 one-off runs reused the `stockvision-ml` name so billing could not tell them
apart. The daily HMM maintenance tick calls run_inventory_alert(); it lists the
workspace's apps and flags ephemeral/detached apps alive longer than 24 h or
running under a deployed app's name.

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
        'state': api_pb2.AppState.Name(item.state).removeprefix('APP_STATE_').lower(),
        'created_at': float(item.created_at or 0),
        'tasks': int(item.n_running_tasks),
    } for item in _list()]


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
    # Same row shape as the Worker's writeSystemLog (ops domain, SystemStatusBar reads it).
    from services.d1_domain_client import D1DataDomain, client_for_domain
    client_for_domain(D1DataDomain.OPS).execute(
        "INSERT INTO system_logs (level, cron_name, message, meta, created_at) "
        "VALUES (?, ?, ?, ?, datetime('now'))",
        [level, CRON_NAME, message, json.dumps(meta)],
        timeout=10.0,
    )


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
    """Async entry for the daily tick; skipped where the process has no Modal token."""
    if not os.environ.get('MODAL_TOKEN_ID'):
        return {'status': 'skipped', 'reason': 'modal_token_unset'}
    return await asyncio.to_thread(run_inventory)


async def settle(task: asyncio.Task, timeout: float = INVENTORY_TIMEOUT_SEC) -> None:
    """Wait for a side inventory without letting it fail or stall its host request."""
    try:
        await asyncio.wait_for(task, timeout)
    except Exception as exc:  # noqa: BLE001 - ops telemetry must never block the caller.
        logger.warning('[modal_app_inventory] inventory failed (non-fatal): %r', exc)
