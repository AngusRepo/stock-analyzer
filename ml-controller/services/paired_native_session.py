"""Full-session orchestration of the original native paper engine.

This module never creates a fill. It verifies both native results against the
independent costed journal before publishing a durable execution receipt.
"""
from __future__ import annotations

from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import math
from pathlib import Path
from typing import Any

from services.native_paper_sandbox import PrivatePaperStore, run_native_paper_frames
from services.paired_nav_journal import (
    _timestamp, account_value, digest, read_snapshot, replay_session, stage_execution_receipt,
)

TW = timezone(timedelta(hours=8))
ARMS = ('baseline', 'candidate')


def session_schedule(session_date: str) -> list[dict[str, str]]:
    """Explicit same-minute serialization, frozen before either arm executes.

    Intraday runs first, then the observe-only rescore / EOD phase. This is a
    paired execution policy, not a claim that independent production crons have
    historically run in that order. Both arms must use this identical policy.
    """
    day = date.fromisoformat(session_date)
    if day.weekday() > 4:
        raise ValueError('paired_native_nonweekday_session')
    start = datetime.combine(day, datetime.min.time(), tzinfo=TW)
    schedule = []

    def add(stage, minute, cron=None):
        row = {'stage': stage, 'observed_at': (start + timedelta(minutes=minute)).isoformat()}
        if cron:
            row['cron'] = cron
        row['input_id'] = digest(row)
        schedule.append(row)

    add('settlement', 435)
    add('morning', 435)
    add('preopen', 530)
    rescores = {600: '0 2 * * 1-5', 660: '0 3 * * 1-5',
                720: '0 4 * * 1-5', 750: '30 4 * * 1-5'}
    for minute in range(540, 811):
        add('intraday', minute)
        if minute in rescores:
            add('rescore', minute, rescores[minute])
        if minute == 805:
            add('eod', minute)
    add('postclose', 820)
    add('snapshot', 860)
    return schedule


def validate_schedule(schedule: list[dict[str, Any]], session_date: str) -> None:
    if schedule != session_schedule(session_date):
        raise ValueError('paired_native_full_schedule_mismatch')


def native_fills(frames: list[dict[str, Any]], account_id: int) -> list[dict[str, Any]]:
    fills, seen = [], set()
    for wrapped in frames:
        result = wrapped['result']
        if result['account_id'] != account_id:
            raise ValueError('paired_native_account_mismatch')
        for order in result['orders']:
            if order['id'] in seen:
                raise ValueError('paired_native_duplicate_order')
            seen.add(order['id'])
            note = json.loads(order.get('note') or '{}')
            day_trade = False if order['side'] == 'buy' else note.get('is_day_trade')
            if type(day_trade) is not bool:
                raise ValueError('paired_native_tax_decision_missing')
            # Native SQLite CURRENT_TIMESTAMP is UTC, not Taiwan local time.
            stamp = str(order['created_at']).replace(' ', 'T')
            if datetime.fromisoformat(stamp.replace('Z', '+00:00')).tzinfo is None:
                stamp += '+00:00'
            start = _timestamp(result.get('started_at', result['observed_at'])).replace(microsecond=0)
            end = _timestamp(result.get('completed_at', result['observed_at']))
            if not start <= _timestamp(stamp) <= end:
                raise ValueError('paired_native_order_clock_mismatch')
            fills.append({'fill_id': str(order['id']), 'symbol': order['symbol'], 'side': order['side'],
                'shares': order['shares'], 'price': order['price'], 'commission': order['commission'],
                'tax': order['tax'], 'is_day_trade': day_trade, 'executed_at': stamp})
    return fills


def validate_native_account(native: dict[str, Any], ledger: dict[str, Any]) -> None:
    if native.get('positions') != ledger['positions']:
        raise ValueError('paired_native_positions_do_not_reconcile')
    fields = ('action_id', 'symbol', 'kind', 'ex_date', 'eligible_shares', 'cash_due', 'shares_due', 'payable_date')
    def rights(account):
        return sorted([{**{k: r[k] for k in fields},
            'fractional_treatment': r.get('fractional_treatment'),
            'cash_rounding': r.get('cash_rounding'),
            'rights': json.loads(r['rights_json']) if r.get('kind') == 'subscription' else None,
            'whole_shares_due': r.get('whole_shares_due', math.floor(r['shares_due']))}
            for r in account.get('corporate_receivables', [])], key=lambda r: r['action_id'])
    if rights(native) != rights(ledger):
        raise ValueError('paired_native_corporate_receivables_do_not_reconcile')
    fields_to_check = ['cash', 'nav']
    if ledger.get('nav') is None:
        if native.get('nav', 'missing') is not None or native.get('valuation_complete') is not False:
            raise ValueError('paired_native_nav_does_not_reconcile')
        if native.get('unpriced_rights') != ledger.get('unpriced_rights'):
            raise ValueError('paired_native_corporate_receivables_do_not_reconcile')
        fields_to_check = ['cash', 'nav_lower_bound', 'nav_upper_bound']
    for key in fields_to_check:
        value = native.get(key)
        if (isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value)
                or not math.isclose(value, ledger[key], rel_tol=1e-12, abs_tol=1e-6)):
            raise ValueError('paired_native_' + key + '_does_not_reconcile')


def run_paired_session(*, snapshot_id: str, tapes: dict[str, Any], states: dict[str, Any],
                       query, writer, now: datetime | None = None, runner: Path | None = None,
                       timeout_seconds: float = 120, state_objects=None,
                       expected_final_checksums: dict[str, str] | None = None) -> dict[str, Any]:
    saved = read_snapshot(query, snapshot_id)
    manifest, packet = saved['manifest'], saved['payload']['content']
    if manifest['snapshot_kind'] != 'execution_pair' or manifest['prospective'] != 1:
        raise ValueError('paired_native_prospective_pair_required')
    clock = now or datetime.now(timezone.utc)
    from services.paired_native_models import DUAL_INPUT_OWNERS, prediction_arms
    if packet.get('owner') in DUAL_INPUT_OWNERS:
        prediction_arms(packet)
    configuration = packet['configuration']
    if (digest(configuration) != packet['configuration_checksum']
            or configuration['trading_config']['fees'] != packet['fees']
            or configuration.get('fees') != packet['fees']):
        raise ValueError('paired_native_configuration_mismatch')
    schedule = packet['schedule']
    validate_schedule(schedule, packet['session_date'])
    if _timestamp(schedule[-1]['observed_at']) > clock:
        raise ValueError('paired_native_session_not_closed')
    if _timestamp(manifest['frozen_at']) >= _timestamp(schedule[0]['observed_at']):
        raise ValueError('paired_native_pair_not_frozen_before_first_phase')
    if set(states) != set(ARMS) or set(tapes) != set(ARMS):
        raise ValueError('paired_native_both_arms_required')
    previous_rows = query('SELECT session_date,payload_json,payload_checksum FROM paired_nav_daily_journal_v1 '
                          'WHERE pair_id=? AND session_date<? ORDER BY session_date DESC LIMIT 1',
                          [packet['pair_id'], packet['session_date']])
    if previous_rows:
        row = previous_rows[0]
        previous = json.loads(row['payload_json'])
        if digest(previous) != row['payload_checksum'] or row['session_date'] != packet['previous_session_date']:
            raise ValueError('paired_native_previous_journal_mismatch')
        opening = previous['arms']
    else:
        if packet.get('previous_session_date') is not None:
            raise ValueError('paired_native_previous_journal_missing')
        initial = packet['initial_account']
        if account_value(initial, initial['marks']) != initial['nav']:
            raise ValueError('paired_native_initial_nav_mismatch')
        opening = {arm: initial for arm in ARMS}
    outputs, receipts, valuations = {}, {}, {}
    from services.paired_nav_chain import read_verified_cash_history
    cash_history = read_verified_cash_history(query=query, pair_id=packet['pair_id'],
        before_date=packet['session_date'], now=clock)
    shared_source = None
    for arm in ARMS:
        state, tape = states[arm], tapes[arm]
        if state['state_checksum'] != packet['initial_state_checksums'][arm]:
            raise ValueError('paired_native_start_state_changed')
        if hashlib.sha256(state['state_sql'].encode()).hexdigest() != state['state_checksum']:
            raise ValueError('paired_native_start_state_corrupt')
        private = PrivatePaperStore(state['state_sql'], state['state_checksum'], {})
        try:
            for key, expected in (('trading:config', configuration['trading_config']),
                                  ('trading:risk_config', configuration['risk_config'])):
                row = private.db.execute('SELECT value FROM _native_private_kv WHERE key=?', (key,)).fetchone()
                if row is None or json.loads(row[0]) != expected:
                    raise ValueError('paired_native_private_configuration_mismatch')
        finally:
            private.db.close()
        if set(tape['frames']) != {frame['input_id'] for frame in schedule}:
            raise ValueError('paired_native_frame_coverage_incomplete')
        for frame in schedule:
            actual = tape['frames'][frame['input_id']]
            if any(actual.get(key) != value for key, value in frame.items()):
                raise ValueError('paired_native_frame_identity_mismatch')
            from services.paired_native_models import validate_model_frame
            validate_model_frame(packet, arm, actual)
        # The immutable collector receipt binds common source data, while each
        # arm has its own prompt/request transcript and private portfolio state.
        source = tape['source_receipt']
        if (source['session_date'] != packet['session_date'] or source.get('complete') is not True
                or source.get('schedule_checksum') != digest(schedule)
                or not _timestamp(schedule[-1]['observed_at']) <= _timestamp(source['closed_at']) <= clock):
            raise ValueError('paired_native_source_receipt_incomplete')
        if shared_source is not None and source != shared_source:
            raise ValueError('paired_native_common_source_mismatch')
        shared_source = source
        output = run_native_paper_frames(state_sql=state['state_sql'], state_checksum=state['state_checksum'],
            frame_inputs=tape['frames'], frames=schedule, account_id=packet['account_id'],
            variables=packet['variables'], runner=runner, timeout_seconds=timeout_seconds,
            expected_execution_owner_version=packet['execution_owner_version'])
        if len(output['frames']) != len(schedule):
            raise ValueError('paired_native_result_coverage_incomplete')
        for frame, wrapped in zip(schedule, output['frames']):
            result = wrapped['result']
            if result['stage'] != frame['stage'] or _timestamp(result['observed_at']) != _timestamp(frame['observed_at']):
                raise ValueError('paired_native_result_identity_mismatch')
        valuations[arm] = output['frames'][-1]['result']['valuation']
        receipts[arm] = {'complete': True, 'fills': native_fills(output['frames'], packet['account_id'])}
        outputs[arm] = output
    if expected_final_checksums is not None and any(
            outputs[arm]['state_checksum'] != expected_final_checksums.get(arm) for arm in ARMS):
        raise ValueError('paired_native_collected_replay_state_mismatch')
    source = shared_source
    actions = source['corporate_actions']
    if source.get('corporate_actions_complete') is not True:
        raise ValueError('paired_native_corporate_action_coverage_missing')
    marks = source['closing_marks']
    for arm in ARMS:
        valuation = valuations[arm]
        marked_symbols = set(valuation['positions']) | {r['symbol'] for r in valuation.get('corporate_receivables', [])
            if r['shares_due'] > 0 or r.get('kind') == 'subscription'}
        for symbol in marked_symbols:
            if valuation['marks'].get(symbol) != marks.get(symbol):
                raise ValueError('paired_native_close_mark_mismatch')
        ledger = replay_session(previous=opening[arm], fills=receipts[arm]['fills'], marks=marks,
            corporate_actions=actions, session_date=packet['session_date'], fees=packet['fees'], allow_unpriced_rights=True,
            cash_history=cash_history[arm])
        validate_native_account(valuation, ledger)
    receipt = {key: packet[key] for key in ('pair_id', 'candidate_checksum', 'baseline_checksum',
               'execution_owner_version', 'configuration_checksum', 'session_date')}
    receipt.update({'snapshot_id': snapshot_id, 'observed_at': source['closed_at'],
        'session_complete': True, 'corporate_actions_complete': True, 'corporate_actions': actions,
        'cash_accounting_version': 1,
        'valuation_complete': all(valuations[arm].get('nav') is not None for arm in ARMS),
        'marks': marks, 'arms': receipts, 'source_checksum': digest(source),
        'native_state_checksums': {arm: outputs[arm]['state_checksum'] for arm in ARMS},
        'native_input_checksums': {arm: outputs[arm]['input_checksum'] for arm in ARMS}})
    # Persist BOTH carry states before acknowledging the session receipt. An
    # interrupted upload must never leave a mature day with missing next state.
    if state_objects is not None:
        receipt['native_state_objects'] = {arm: state_objects.put(
            {key: outputs[arm][key] for key in ('state_sql', 'state_checksum')}) for arm in ARMS}
        for arm in ARMS:
            if state_objects.get(receipt['native_state_objects'][arm])['state_checksum'] != outputs[arm]['state_checksum']:
                raise ValueError('paired_native_state_publication_mismatch')
    seal = stage_execution_receipt(execution=receipt, query=query, writer=writer, now=clock)
    return {'receipt_snapshot_id': seal['snapshot_id'], 'execution': receipt,
        'states': {arm: {key: outputs[arm][key] for key in ('state_sql', 'state_checksum')} for arm in ARMS},
        'production_effect': False, 'promotion_allowed': False, 'ev_prediction_dates_added': 0}
