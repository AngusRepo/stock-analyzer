"""Pre-session allocation-pair -> immutable native execution registration.

Uses the original private bootstrap/serializer. Existing pair state is carried
from its verified receipt, never reset from the current formal account.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path

from services.native_paper_bootstrap import capture_native_bootstrap
from services.native_paper_sandbox import native_runtime_manifest, PrivatePaperStore
from services.native_paper_state import prepare_native_state
from services.paired_native_session import ARMS, session_schedule
from services.paired_nav_journal import _timestamp, account_value, digest, freeze_snapshot, read_snapshot


def validate_carry_context(previous: dict, *, allocation: dict, runtime: dict,
                           account_id: int, variables: dict, kv_read_policy: dict,
                           source_context: dict | None) -> None:
    """A continuous NAV comparison cannot silently change its execution experiment.

    Source capture clocks and market observations may advance. Account ownership,
    engine flags and frozen execution policies may not change under the same pair.
    Reject before publishing a new session; never reset its accumulated journal.
    """
    from services.native_execution_equivalence import policy_execution_owner

    expected = {key: allocation[key] for key in ('pair_id', 'candidate_checksum', 'baseline_checksum')}
    expected.update(account_id=account_id, execution_owner_version=runtime['execution_owner_version'],
                    variables=variables)
    for key, value in expected.items():
        observed = previous.get(key)
        if key == 'execution_owner_version' and isinstance(observed, str):
            observed, value = policy_execution_owner(observed), policy_execution_owner(value)
        if observed != value:
            raise ValueError('paired_native_carry_context_changed:' + key)
    config = {**allocation['configuration'], 'fees': allocation['configuration']['trading_config']['fees']}
    if previous.get('configuration_checksum') != digest(config):
        raise ValueError('paired_native_carry_context_changed:configuration')
    if previous.get('kv_read_policy', {}) != kv_read_policy:
        raise ValueError('paired_native_carry_context_changed:kv_read_policy')
    def policies(context):
        # JSON formatting is not an economic policy change. Missing and explicit
        # null remain distinct so a new policy cannot reuse an unobserved one.
        return {key: json.loads(raw) if raw is not None else None
                for key, raw in (context or {}).get('frozen_kv', {}).items()}
    if 'native_execution_policy' in allocation['configuration']:
        # New frozen environments distinguish ordinary daily adaptive state
        # from stable policy. Legacy comparisons retain their original identity.
        from services.paired_nav_execution_environment import frozen_policy_identity
        policies = frozen_policy_identity
    if policies(previous.get('source_context')) != policies(source_context):
        raise ValueError('paired_native_carry_context_changed:frozen_kv')


def next_session(signal_date: str, *, kv_read, now: datetime) -> tuple[str, dict]:
    day = date.fromisoformat(signal_date)
    receipts = {}
    for offset in range(1, 16):
        target = day + timedelta(days=offset)
        if target.weekday() >= 5:
            continue
        key = f'market:twse_holiday_schedule:v2:{target.year}'
        if key not in receipts:
            raw = kv_read(key)
            if raw is None:
                raise ValueError('paired_native_official_calendar_missing')
            packet = json.loads(raw)
            if (packet.get('schemaVersion') != 'twse-holiday-schedule-v2'
                    or packet.get('source') != 'twse.openapi.holidaySchedule'
                    or not isinstance(packet.get('dates'), list)
                    or not timedelta(0) <= now - _timestamp(packet['loadedAt']) <= timedelta(days=7)):
                raise ValueError('paired_native_official_calendar_invalid_or_stale')
            receipts[key] = packet
        target_date = target.isoformat()
        override_key = 'holiday:' + target_date
        receipts[override_key] = kv_read(override_key)
        if target_date in receipts[key]['dates'] or receipts[override_key]:
            continue
        return target_date, receipts
    raise ValueError('paired_native_next_session_missing')


def register_allocation_pair(*, snapshot_id: str, query, writer, domain_queries: dict, kv_read,
                             objects, account_id: int, variables: dict, kv_read_policy: dict,
                             runner: Path | None = None, now: datetime | None = None,
                             source_context: dict | None = None) -> dict:
    clock = now or datetime.now(timezone.utc)
    saved = read_snapshot(query, snapshot_id)
    manifest, allocation = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'allocation_pair' or manifest['prospective'] != 1:
        raise ValueError('paired_native_prospective_allocation_required')
    signal_date = manifest['signal_date']
    source_run_id = allocation['pair_id']
    registered_id = digest(['execution_pair', signal_date, source_run_id])
    if query('SELECT snapshot_id FROM paired_nav_frozen_manifests_v1 WHERE snapshot_id=?', [registered_id]):
        existing = read_snapshot(query, registered_id)
        if existing['payload']['content']['allocation_snapshot_id'] != snapshot_id:
            raise ValueError('paired_native_registered_allocation_changed')
        return existing['manifest']
    from services.paired_nav_lifecycle import closure_for_pair
    if closure_for_pair(source_run_id, signal_date=signal_date, query=query):
        raise ValueError('paired_native_closed_pair_cannot_restart')
    session_date, calendar = next_session(signal_date, kv_read=kv_read, now=clock)
    schedule = session_schedule(session_date)
    if not clock < _timestamp(schedule[0]['observed_at']):
        raise ValueError('paired_native_registration_after_first_phase')
    configuration = allocation['configuration']
    if digest(configuration) != allocation['configuration_checksum']:
        raise ValueError('paired_native_allocation_configuration_corrupt')
    parent_id = allocation.get('allocation_context_snapshot_id')
    if not parent_id:
        raise ValueError('paired_native_frozen_model_parent_missing')
    parent = read_snapshot(query, parent_id)
    if (parent['manifest']['snapshot_kind'] != 'allocation_context'
            or parent['manifest']['signal_date'] != signal_date
            or parent['manifest']['prospective'] != 1):
        raise ValueError('paired_native_frozen_model_parent_mismatch')
    from services.paired_native_models import model_context_fields, prediction_arms
    models = model_context_fields(parent['payload']['content'], allocation)
    atomic_seeds = None
    native_holdings = None
    if allocation.get('owner') == 'atomic_strategy':
        from services.paired_nav_atomic_candidate import verify_atomic_comparison
        atomic_seeds = verify_atomic_comparison(allocation, parent, query=query)
        native_holdings = parent['payload']['content']['atomic_recommendation_inputs'].get('native_holdings')
        if native_holdings is not None:
            if native_holdings['account_id'] != account_id:
                raise ValueError('paired_native_holdings_account_mismatch')
            if _timestamp(native_holdings['observed_at']) > _timestamp(parent['manifest']['frozen_at']):
                raise ValueError('paired_native_holdings_observed_after_freeze')
    runtime = native_runtime_manifest(runner)
    from services.paired_nav_execution_environment import validate_registered_environment
    validate_registered_environment(parent=parent, allocation=allocation, runtime=runtime,
        account_id=account_id, variables=variables, kv_read_policy=kv_read_policy, source_context=source_context)
    # A close receipt may have arrived while its journal write failed. Recover
    # only this pair's already sealed receipts through the original accountant;
    # the next session must not depend on a later OOF/nightly job. Missing
    # receipts/states still fail below, and unrelated pairs are never consumed.
    from services.paired_nav_journal import materialize_staged_receipts
    materialize_staged_receipts(business_date=signal_date, pair_id=source_run_id,
        query=query, writer=writer, now=clock)
    bootstrap = capture_native_bootstrap(domain_queries=domain_queries, ownership=runtime['tables'],
        account_id=account_id, signal_date=signal_date, frozen_kv={})
    from services.paired_native_carry import read_native_carry
    previous = read_native_carry(pair_id=source_run_id, signal_date=signal_date, query=query, objects=objects, now=clock)
    previous_date = None
    if previous:
        previous_registration = previous['registration']
        # Daily forecasts may advance, but the model/cohort being compared may
        # not change under an existing NAV pair or silently revert to incumbent.
        from services.paired_native_models import validate_prediction_carry
        validate_prediction_carry(previous_registration, {**allocation, **models})
        validate_carry_context(previous_registration, allocation=allocation, runtime=runtime,
            account_id=account_id, variables=variables, kv_read_policy=kv_read_policy,
            source_context=source_context)
        from services.native_execution_equivalence import policy_execution_owner
        if (policy_execution_owner(previous_registration['execution_owner_version'])
                != policy_execution_owner(runtime['execution_owner_version'])):
            raise ValueError('paired_native_carry_execution_owner_changed')
        starts = previous['states']
        previous_date = signal_date
        initial = None
    else:
        # Missing current-account observation cannot be relabeled as an empty
        # bootstrap when the same definition already has an older comparison.
        # Existing pairs above use their verified carry and need no fallback.
        if native_holdings is not None and (native_holdings.get('initial_observation') or {}).get('status') != 'ready':
            raise ValueError('paired_native_initial_holdings_source_unavailable')
        initial_state = {key: bootstrap[key] for key in ('state_sql', 'state_checksum')}
        starts = {arm: initial_state for arm in ARMS}
        store = PrivatePaperStore(**initial_state, inputs={})
        try:
            account = store.db.execute('SELECT cash FROM paper_accounts WHERE id=?', (account_id,)).fetchone()
            pending = store.db.execute("SELECT COALESCE(SUM(CASE WHEN side='sell' THEN amount ELSE -amount END),0) FROM paper_settlements WHERE account_id=? AND settled=0", (account_id,)).fetchone()[0]
            positions = {row['symbol']: row['shares'] for row in store.db.execute(
                'SELECT symbol,shares FROM paper_positions WHERE account_id=? AND shares>0', (account_id,))}
            receivables = [dict(row) for row in store.db.execute(
                'SELECT * FROM paper_corporate_entitlements_v1 WHERE account_id=? AND settled=0 ORDER BY action_id', (account_id,))]
            marks = {}
            mark_symbols = set(positions) | {row['symbol'] for row in receivables if row['shares_due'] > 0}
            for symbol in sorted(mark_symbols):
                stock = store.db.execute('SELECT id FROM stocks WHERE symbol=?', (symbol,)).fetchone()
                rows = domain_queries['market']('SELECT close FROM stock_prices WHERE stock_id=? AND date=?', [stock['id'], signal_date])
                if len(rows) != 1:
                    raise ValueError('paired_native_initial_mark_missing')
                marks[symbol] = rows[0]['close']
            initial = {'cash': account['cash'] + pending, 'positions': positions, 'marks': marks,
                       'corporate_receivables': receivables}
            initial['nav'] = account_value(initial, marks)
        finally:
            store.db.close()
    from services.paired_nav_strategy_bundle import arm_configuration,verify_strategy_inputs
    strategy_inputs=verify_strategy_inputs(configuration,parent['payload']['content'],signal_date=signal_date)
    states = {}
    for arm in ARMS:
        arm_config=arm_configuration(configuration,arm,signal_date=signal_date)
        arm_inputs=(strategy_inputs[arm] if strategy_inputs is not None else parent['payload']['content'].get('inputs'))
        prepared = prepare_native_state(base_state=starts[arm],
            seed_rows=atomic_seeds[arm] if atomic_seeds is not None else bootstrap['seed_rows'],
            recommendations=allocation[arm]['recommendations'], signal_date=signal_date,
            trading_config=arm_config, risk_config=configuration['risk_config'],
            stock_rows=bootstrap['stock_rows'], frozen_kv=(source_context or {}).get('frozen_kv'),
            l4_allocation_inputs=arm_inputs if arm_config.get('l4Distribution') else None,
            allocation_snapshot_id=parent_id)
        # The generic serializer may ignore ML-only/nonseed rows, but a paired
        # allocation must execute its entire sealed slate or the NAV contrast
        # no longer measures the candidate we registered.
        if prepared.get('ignored_nonseed_symbols'):
            raise ValueError('native_registration_allocation_seed_coverage_missing')
        states[arm] = {key: prepared[key] for key in ('state_sql', 'state_checksum')}
        if allocation.get('owner') == 'atomic_strategy':
            from services.paired_nav_native_holdings import _account_rows, _symbols
            store = PrivatePaperStore(**states[arm], inputs={})
            try:
                held = _symbols(_account_rows(lambda sql,args:[dict(r) for r in store.db.execute(sql,args)], account_id))
                if not set(held) <= set(prediction_arms({**allocation, **models})[arm]['predictions']):
                    raise ValueError('paired_native_registration_holding_predictions_missing')
            finally:
                store.db.close()
    if allocation.get('owner') == 'ensemble' and configuration.get('strategy_bundle'):
        from services.paired_native_rescore_carry import build_rescore_carry
        from services.paired_nav_native_holdings import _account_rows, _symbols
        held_symbols = {}
        for arm in ARMS:
            store = PrivatePaperStore(**states[arm], inputs={})
            try:
                held_symbols[arm] = _symbols(_account_rows(
                    lambda sql,args:[dict(r) for r in store.db.execute(sql,args)], account_id))
            finally:
                store.db.close()
        previous_id = previous['reference']['execution_snapshot_id'] if previous else None
        previous_signal = read_snapshot(query, previous_id)['manifest']['signal_date'] if previous_id else None
        models['model_rescore_context'] = build_rescore_carry(current={**allocation, **models},
            previous=previous['registration'] if previous else None, held_symbols=held_symbols,
            signal_date=signal_date, previous_snapshot_id=previous_id, previous_signal_date=previous_signal)
    # Freeze fee config in the exact journal contract without changing original
    # allocation identity; no efficacy or serving approval is manufactured.
    configuration = {**configuration, 'fees': configuration['trading_config']['fees']}
    packet = {key: allocation[key] for key in ('pair_id', 'owner', 'candidate_checksum', 'baseline_checksum')}
    packet.update({'allocation_snapshot_id': snapshot_id, 'configuration': configuration,
        'allocation_context_snapshot_id': parent_id, **models,
        'configuration_checksum': digest(configuration), 'fees': configuration['fees'],
        'execution_owner_version': runtime['execution_owner_version'], 'account_id': account_id,
        'variables': variables, 'initial_account': initial, 'previous_session_date': previous_date,
        'source_context': source_context,
        'session_date': session_date, 'session_open_at': session_date + 'T01:00:00Z',
        'session_close_at': session_date + 'T05:30:00Z', 'schedule': schedule,
        'source_tables': bootstrap['source_tables'], 'calendar': calendar,
        'capture_kv_reads': True, 'kv_read_policy': kv_read_policy,
        'initial_state_objects': {arm: objects.put(states[arm]) for arm in ARMS},
        'initial_state_checksums': {arm: states[arm]['state_checksum'] for arm in ARMS}})
    return freeze_snapshot(signal_date=signal_date, source_run_id=source_run_id, snapshot_kind='execution_pair',
                           content=packet, query=query, writer=writer, now=clock)
