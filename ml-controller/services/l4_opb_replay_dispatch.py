"""Dispatch of the OPB arm replay outside the OOF job (research evidence only).

Kept out of the allocator source files (paired_nav_collection.allocator_runtime_source_identity):
how the replay is scheduled does not change what a replayed arm returns, so changing
this module must not move the OPB context.

Asynchronous: the Worker's active8-oof-daily task asks the controller to start one
execution of the existing OOF materialize Cloud Run Job in mode `opb_arm_replay`
and returns at once. The job (memory and time for a 0.8-2.4 GB snapshot and a
~2 min solve per new day) runs the replay to completion and writes a run receipt
to l4_opb_arm_replay_runs_v1; the Worker's next tick reads that receipt.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path

JOB_MODE = 'opb_arm_replay'
# Not 'daily': the OOF daily dispatch guard (active8_daily_dispatch_guard) counts only
# daily-cadence executions, so a replay execution never stands in for the day's OOF job.
JOB_CADENCE = 'opb_arm_replay'
JOB_DATE_ENV = 'OOF_MATERIALIZE_OPB_REPLAY_DATE'
# Executions started per business date (not per night), claimed one at a time under a GCS
# generation match before each RunJob (active8_daily_dispatch_guard.dispatch_replay_guarded,
# keyed by business date; seeded from the provider's execution list). Engineering bound, not
# a trading parameter: each execution solves at most 10 days (BACKFILL_DATES_PER_RUN, ~41 min
# worst case; the job's task timeout is deploy_ml_controller.sh OOF_MATERIALIZE_JOB_TIMEOUT,
# read from the job at dispatch), so 4 cover the 34-day backlog seen after the 11/23-24
# re-pin in one business date and a full 65-day window in two. A run with no progress
# already ends the business date (receipt complete=1); this cap covers executions that never
# write a receipt (OOM, timeout). When one business date spans several nights (a weekend),
# the 4 are shared by those nights: a Friday business date capped on Friday night is not
# replayed again over the weekend, and the next business date (its own 4) books the backlog
# (attach_daily_replay replays every unbooked day up to its book_through).
# 31 business dates x 4 stays under the daily dispatch guard's replay scan allowance (200).
MAX_EXECUTIONS_PER_BUSINESS_DATE = 4
# One deadline from the route entry covers the config read, the GCS claim, the execution
# list and RunJob; each step gets what is left. Under the Worker's 45 s request timeout
# (OPB_REPLAY_DISPATCH_TIMEOUT_MS) with room for the HTTP round trip.
TOTAL_DEADLINE_SECONDS = 40
CONFIG_DEADLINE_SECONDS = 12
# The replay shares the OOF daily job, so a running replay execution makes the OOF daily
# dispatch answer pending until it ends (run_job reject_if_running). Each night's replay
# window opens at the OOF daily main tick and closes for good, until the next main tick,
# once one execution started now could still run within the margin before the night's last
# OOF daily watchdog tick (the OOF ticks within one day of the main tick). Past that tick
# the day's OOF job is dispatched by the premarket publication's continuation (the
# premarket evidence watchdog runs to TW 08:50): a collision there is retried
# (updateOrchestrator.planActive8OofContinuationCollisionRetry, 600-1800 s apart, up to
# ACTIVE8_OOF_CONTINUATION_MAX_ATTEMPTS = 64) and the next watchdog night re-dispatches,
# but every collision delays the day's OOF job by a retry interval, so no replay may be
# running then either. The window is therefore not reopened by a later tick (a 07:55 tick
# delivered at 07:55:05, a continuation at 08:30): it reopens only at the next main tick.
# A night whose main tick does not fire (a weekday-only main on a weekend) has no window.
# Every night with a window may replay, within the business date's
# MAX_EXECUTIONS_PER_BUSINESS_DATE and until the Worker's marker closes that date.
# Not handled here: active8-oof-weekly and active8-oof-monthly run on the same Cloud Run
# job and are PAUSED today. The monthly's first-Sunday TW 02:00 falls inside this window
# (and the weekly's Sunday TW 07:05 near its end); before either is resumed, its ticks must
# be added to this window (or the replay kept off those nights), or a replay can hold the
# job when it fires.
# Ticks come from infra/gcp-scheduler-jobs.json (copied into the image, hashed by the
# release build); the longest execution, (max_retries + 1) x task timeout, from the deployed
# job (deploy_ml_controller.sh OOF_MATERIALIZE_JOB_TIMEOUT, --max-retries), so neither is a
# second copy. The margin is shorter than one watchdog interval (a tick plus a few seconds
# of delivery still dispatches) and leaves the last tick at least this long after any
# replay can end. Engineering bound.
OOF_DAILY_TASK = 'active8-oof-daily'
SCHEDULER_MANIFEST = 'gcp-scheduler-jobs.json'
REPLAY_WINDOW_MARGIN_SECONDS = 25 * 60
# Scheduler span scanned before and after `now` for the previous and the next main tick
# (covers a weekly or weekday-only main); none found either way fails closed.
SCHEDULE_LOOKBACK_DAYS = 8
SCHEDULE_LOOKAHEAD_DAYS = 8
RUN_SCHEMA = 'l4-opb-arm-replay-run-v1'
RUN_COLUMNS = ('business_date', 'execution_id', 'schema_version', 'status', 'complete', 'progress',
               'failed_dates_json', 'deferred_dates_json', 'rejected_dates_json', 'missing_price_dates_json',
               'finished_at')


def _policy_is_v3(config):
    from services.l4_opb_arm_replay import is_v3
    return is_v3(config.get('l4Distribution'))


def _load_config(timeout=10.0):
    from services.trading_config_loader import load_merged_trading_config_with_contract
    return load_merged_trading_config_with_contract(timeout=timeout).config


def _load_config_within(seconds):
    """_load_config bounded in wall time (its raw KV read has no timeout parameter)."""
    from concurrent.futures import ThreadPoolExecutor
    if seconds <= 0:
        raise TimeoutError('opb_arm_replay_dispatch_deadline')
    pool = ThreadPoolExecutor(1)
    try:
        return pool.submit(_load_config, seconds).result(timeout=seconds)
    finally:
        pool.shutdown(wait=False)            # a late read finishes on its own; nothing waits


def _scheduler_manifest():
    source = Path(__file__).resolve()
    for candidate in (source.parents[2] / 'infra' / SCHEDULER_MANIFEST, source.parents[1] / 'infra' / SCHEDULER_MANIFEST):
        if candidate.exists():
            return json.loads(candidate.read_text(encoding='utf-8'))
    raise RuntimeError('scheduler_manifest_missing')


def _cron_values(field, low, high):
    """One cron field (numbers, `*`, `a-b`, steps `*/n`, `a/n`, `a-b/n`); anything else fails closed."""
    import re
    values = set()
    for part in field.split(','):
        if not re.fullmatch(r'(\*|[0-9]+|[0-9]+-[0-9]+)(/[0-9]+)?', part):
            raise ValueError('oof_daily_schedule_unsupported')
        span, slash, step = part.partition('/')
        if span == '*':
            start, stop = low, high
        elif '-' in span:
            start, stop = (int(v) for v in span.split('-'))
        else:
            start = int(span)
            stop = high if slash else start          # cron: `a/n` runs a, a+n, ... to the top
        if not low <= start <= stop <= high or (slash and int(step) < 1):
            raise ValueError('oof_daily_schedule_unsupported')
        values.update(range(start, stop + 1, int(step) if slash else 1))
    return values


def fire_times(job, manifest, start, end):
    """Every instant (UTC) in [start, end) at which a 5-field cron job fires, in its own zone."""
    from zoneinfo import ZoneInfo
    fields = str(job.get('schedule', '')).split()
    if len(fields) != 5:
        raise ValueError('oof_daily_schedule_unsupported')
    minutes, hours, days, months = (_cron_values(f, lo, hi) for f, lo, hi in
                                    zip(fields, (0, 0, 1, 1), (59, 23, 31, 12)))
    weekdays = {d % 7 for d in _cron_values(fields[4], 0, 7)}    # 0 and 7 are Sunday
    if fields[2] != '*' and fields[4] != '*':
        # Both day fields restricted: Vixie cron ORs them unless one starts with `*` (then
        # AND), and Cloud Scheduler documents neither; no manifest job needs it, so no guess.
        raise ValueError('oof_daily_schedule_unsupported')
    zone = ZoneInfo(job.get('timeZone') or manifest.get('timeZone') or 'UTC')
    first, last = start.astimezone(zone).date() - timedelta(days=1), end.astimezone(zone).date() + timedelta(days=1)
    out, day = [], first
    while day <= last:
        # At most one day field is restricted (above): the other matches every day.
        if day.day in days and (day.isoweekday() % 7) in weekdays and day.month in months:
            for hour in sorted(hours):
                for minute in sorted(minutes):
                    instant = datetime(day.year, day.month, day.day, hour, minute, tzinfo=zone).astimezone(timezone.utc)
                    if start <= instant < end:
                        out.append(instant)
        day += timedelta(days=1)
    return sorted(out)


def replay_window(now, manifest=None):
    """(opened, last_tick) of the night `now` is in: the latest OOF daily main tick at or
    before `now`, and the last fire of any active OOF daily job before the next main tick
    and within one day of `opened` (real instants, so a night crossing midnight in any
    zone orders correctly; a main tick that skips days opens no window on them)."""
    if now.tzinfo is None:
        raise ValueError('replay_window_naive_now')
    manifest = _scheduler_manifest() if manifest is None else manifest
    jobs = [j for j in manifest.get('jobs') or () if j.get('task') == OOF_DAILY_TASK and j.get('desiredState') != 'PAUSED']
    main = [j for j in jobs if j.get('id') == OOF_DAILY_TASK]
    if len(main) != 1:
        raise ValueError('oof_daily_schedule_unsupported')
    start, end = now - timedelta(days=SCHEDULE_LOOKBACK_DAYS), now + timedelta(days=SCHEDULE_LOOKAHEAD_DAYS)
    mains = fire_times(main[0], manifest, start, end)
    opened = max((t for t in mains if t <= now), default=None)
    following = min((t for t in mains if t > now), default=None)
    if opened is None or following is None:
        raise ValueError('oof_daily_schedule_unsupported')
    ticks = [t for job in jobs for t in fire_times(job, manifest, opened, min(following, opened + timedelta(days=1)))]
    return opened, max(ticks)


def execution_seconds(jobs, deadline):
    """Longest wall time of one execution of the deployed job: (max_retries + 1) x task timeout."""
    import time
    from google.cloud import run_v2
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise TimeoutError('opb_arm_replay_dispatch_deadline')
    job = jobs._get_client().get_job(request=run_v2.GetJobRequest(name=jobs._parent),
                                     timeout=min(8.0, remaining), retry=None)
    task = job.template.template
    value = task.timeout
    seconds = value.total_seconds() if hasattr(value, 'total_seconds') else value.seconds + value.nanos / 1e9
    if not seconds > 0:
        raise ValueError('oof_job_task_timeout_unreadable')
    # Unset means Cloud Run's own default (3), not 0: only an explicit value is used.
    if 'max_retries' not in task or type(task.max_retries) is not int or task.max_retries < 0:
        raise ValueError('oof_job_max_retries_unreadable')
    return (task.max_retries + 1) * seconds


def outside_window(now, execution_seconds_, manifest=None):
    _, last = replay_window(now, manifest)
    return now + timedelta(seconds=execution_seconds_) > last - timedelta(seconds=REPLAY_WINDOW_MARGIN_SECONDS)


def _utcnow():
    return datetime.now(timezone.utc)


def book_through(business_date):
    """Replay business date for a pipeline date S: every session up to and including S.

    The task runs after S closed (TW 01:55-07:55 of S+1), so S's session is
    bookable (a missing price only defers it); the premarket refresh then only
    prices it, never solves it."""
    return (date.fromisoformat(business_date) + timedelta(days=1)).isoformat()


def dispatch_independent_replay(business_date, *, jobs=None, config=None, bucket=None, deadline=None, now=None):
    """Start one replay execution; never waits for it.

    Returns spawned, busy (an execution of the job runs, or another entry holds the
    claim), capped (the business date's MAX_EXECUTIONS_PER_BUSINESS_DATE executions were started and
    the last has ended), dispatch_failed (config, GCS claim or execution list unreadable,
    or the deadline: nothing started) or skipped with reason `policy_not_v3` or
    `outside_window` (tonight's replay window has closed, see REPLAY_WINDOW_MARGIN_SECONDS;
    `job_running` then says whether an execution of the job runs, None if unreadable, so the
    Worker's busy streak keeps counting a stuck job after the window closed).

    v3 policies only. Under a v2 policy (v1 ledger) the OOF daily job stays the only
    replay owner, exactly as on main: v1 has no verdict table, so an independent run
    would re-read the same not_applicable days every tick, and booking through S+1
    would let v2 arm selection see rows known on S earlier than main does."""
    import time
    deadline = time.monotonic() + TOTAL_DEADLINE_SECONDS if deadline is None else deadline
    date.fromisoformat(business_date)

    def failed(step, exc):
        return {'status': 'dispatch_failed', 'business_date': business_date,
                'reason': f'{step}_failed:{type(exc).__name__}'}
    if config is None:
        try:
            config = _load_config_within(min(CONFIG_DEADLINE_SECONDS, deadline - time.monotonic()))
        except Exception as exc:
            return failed('config_load', exc)
    if not _policy_is_v3(config):
        return {'status': 'skipped', 'business_date': business_date, 'reason': 'policy_not_v3'}
    from services.active8_daily_dispatch_guard import dispatch_replay_guarded
    try:
        if jobs is None:
            from services.cloud_run_jobs_client import CloudRunJobsClient
            jobs = CloudRunJobsClient(job_name=os.environ.get('OOF_MATERIALIZE_JOB_NAME', 'active8-oof-materialize').strip())
        late = outside_window(now or _utcnow(), execution_seconds(jobs, deadline))
    except Exception as exc:
        return failed('window_check', exc)
    if late:
        # Read only (no claim, nothing started); unknown (None) once the deadline is spent.
        try:
            active = jobs.get_active_execution(deadline=deadline)     # each page within the deadline
            running = {'job_running': active is not None,
                       'active_execution': active.execution_id if active is not None else None}
        except Exception:
            running = {'job_running': None, 'active_execution': None}
        return {'status': 'skipped', 'business_date': business_date, 'reason': 'outside_window', **running}
    try:
        if bucket is None:
            from services.walk_forward_retrain import _get_bucket       # the daily fence's bucket
            bucket = _get_bucket()
        # Fail closed: without the claim or the execution list the cap cannot hold, so
        # nothing is started. Not alongside another execution of this job either: a
        # running OOF job books the same ledger (insert-or-verify).
        status, detail = dispatch_replay_guarded(
            jobs, bucket, day=business_date, max_executions=MAX_EXECUTIONS_PER_BUSINESS_DATE, deadline=deadline,
            env_overrides={'OOF_MATERIALIZE_MODE': JOB_MODE, 'OOF_MATERIALIZE_CADENCE': JOB_CADENCE,
                           JOB_DATE_ENV: business_date, 'OOF_MATERIALIZE_RUN_ID': f'opb-arm-replay:{business_date}'})
    except Exception as exc:
        return failed('execution_dispatch', exc)
    if status == 'capped':
        return {'status': 'capped', 'business_date': business_date, 'executions': detail}
    if status == 'busy':
        return {'status': 'busy', 'business_date': business_date,
                'active_execution': detail.execution_id if detail is not None else None}
    return {'status': 'spawned', 'business_date': business_date, 'execution_id': detail.execution_id}


def independent_replay(business_date, *, execution_id, config=None, clients=None, now=None):
    """Job body: replay through `business_date`, then write the run receipt the Worker reads.

    Same rows as the nightly OOF job (insert-or-verify); missed nights are caught
    up by attach_daily_replay. Per execution at most BACKFILL_DATES_PER_RUN days
    do snapshot/solve work, and each (context, day) is solved once."""
    from services.l4_opb_arm_replay import attach_daily_replay
    date.fromisoformat(business_date)
    if config is None:
        config = _load_config()
    if clients is None:
        from services.d1_domain_client import client_proxy_for_domain
        clients = {name: client_proxy_for_domain(name) for name in ('paper', 'learning', 'market')}
    if _policy_is_v3(config):
        result = attach_daily_replay(config, book_through(business_date), clients=clients)
        # P2-5: the business date's first execution may be followed once more when it made no
        # progress only because of transient errors (D1 transport, timeouts).
        result['first_execution'] = _prior_executions(clients['learning'], business_date) == 0
    else:
        # The KV went back to v2 after the dispatch: v1 stays with the OOF job (main
        # behaviour). The receipt is complete, so the Worker stops for the business date.
        result = {'status': 'skipped', 'reason': 'policy_not_v3', 'progress': 0}
    write_run_receipt(clients['learning'], business_date=business_date, execution_id=execution_id,
                      result=result, now=now)
    return {**result, 'business_date': business_date, 'owner': 'independent_dispatch'}


def _prior_executions(learning, business_date):
    try:
        rows = learning.query('SELECT COUNT(*) AS n FROM l4_opb_arm_replay_runs_v1 WHERE business_date=?',
                              [business_date])
        return int(rows[0]['n']) if rows else 0
    except Exception:
        return 1            # unknown: no extra retry, the business date ends on zero progress


def run_complete(result):
    """The business date is done when the run finished everything, or when it made no progress.

    Zero progress (no row booked, no verdict recorded) means another execution for this
    business date would repeat the same work and the same failures, so it is not retried;
    failed and deferred days stay in the receipt (attention on the Worker summary) and are
    tried again on the next business date. Executions per business date are also capped
    (MAX_EXECUTIONS_PER_BUSINESS_DATE, dispatch_independent_replay) for runs that never write a receipt."""
    if result.get('status') == 'skipped':
        return True
    if result.get('status') == 'ok' and not result.get('deferred_dates'):
        return True
    if int(result.get('progress') or 0):
        return False
    # Zero progress: one more try only for the business date's first execution and only when a
    # transient error is involved; deterministic failures never repeat within the business date.
    return not (result.get('first_execution') and int(result.get('transient_failures') or 0))


def write_run_receipt(learning, *, business_date, execution_id, result, now=None):
    """One immutable row per execution; the Worker reads the newest for the date."""
    status = result.get('status') if result.get('status') in ('ok', 'failed', 'skipped') else 'failed'
    record = {'business_date': business_date, 'execution_id': str(execution_id), 'schema_version': RUN_SCHEMA,
              'status': status, 'complete': int(run_complete(result)), 'progress': int(result.get('progress') or 0),
              'failed_dates_json': json.dumps(sorted(result.get('failed_dates') or [])),
              'deferred_dates_json': json.dumps(sorted(result.get('deferred_dates') or [])),
              'rejected_dates_json': json.dumps(sorted(result.get('rejected_dates') or [])),
              'missing_price_dates_json': json.dumps(sorted(result.get('missing_price_dates') or [])),
              'finished_at': (now or datetime.now(timezone.utc)).isoformat()}
    marks = ','.join('?' for _ in RUN_COLUMNS)
    learning.batch_execute([(f'INSERT INTO l4_opb_arm_replay_runs_v1({",".join(RUN_COLUMNS)}) VALUES({marks}) '
                             'ON CONFLICT(business_date,execution_id) DO NOTHING', [record[c] for c in RUN_COLUMNS])])
    return record
