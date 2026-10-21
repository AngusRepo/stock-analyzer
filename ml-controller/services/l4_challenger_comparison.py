"""R30 flexible comparisons; immutable inputs, no model-pointer write authority.

Calibration is an entry attribute. The registry supplies the actual champion and
any number of challengers. Eligibility is sealed separately, before performance.
"""
from __future__ import annotations
from datetime import date, datetime
import hashlib
import json
from services.l4_comparison_statistics import finite, paired_stats, difference

CALIBRATION_ORDER = ('raw', 'linear', 'empirical_bayes')
RULES = {
    'schema': 'r30-champion-challenger-rules-v1',
    'primary': 'preopen_target_weight_exposure_normalized_five_session_excess',
    'label': 'next_session_adjusted_open_to_fifth_session_adjusted_close',
    'zero_exposure': 'missing',
    'bootstrap': {'block_sessions': 5, 'circular': True, 'replicates': 5000,
                  'confidence': .95, 'seed': 20261015, 'preserve_calendar_gaps': True},
    'qualification': 'paired_mean_gt_zero_and_ci_upper_ge_zero',
    'selection': 'largest_paired_mean_then_top_two_paired_ci_contains_zero_simplicity',
    'simplicity': ['fewer_changed_components', *CALIBRATION_ORDER],
    'pool_gate': 'selected_mean_excess_gt_zero',
    'operational_gates': ['solve_success_rate_ge_champion',
                          'target_path_value_weighted_holding_days_ge_champion'],
    'calendar': 'all_common_eligible_mature_sessions_at_user_request',
    'eligibility': 'sealed_data_and_incident_evidence_before_performance',
    'promotion': 'user_confirmation_existing_atomic_owner_only',
    'automatic_demotion': 'service_failure_only',
}

def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':'),
                                    ensure_ascii=False, allow_nan=False).encode()).hexdigest()

def seal(value):
    if 'checksum' in value:
        raise ValueError('already_sealed')
    return {**value, 'checksum': digest(value)}

def verify(value):
    if value.get('checksum') != digest({k: v for k, v in value.items() if k != 'checksum'}):
        raise ValueError('comparison_checksum_mismatch')

def instant(value):
    parsed = datetime.fromisoformat(value.replace('Z', '+00:00'))
    if parsed.tzinfo is None:
        raise ValueError('comparison_timestamp_requires_timezone')
    return parsed

def _day(value):
    if date.fromisoformat(value).isoformat() != value:
        raise ValueError('comparison_date_invalid')
    return value

def component_changes(challenger, champion):
    left, right = challenger['components'], champion['components']
    if not left or set(left) != set(right):
        raise ValueError('component_inventory_mismatch')
    return sum(left[k] != right[k] for k in left)

def qualify_data(*, entry, signal_date, next_open, input_evidence, incidents):
    """Data-only qualification; outcomes and model scores are deliberately absent.

    The adapter must supply verified archive/vintage receipts. A reconstruction
    recorded today is not passed off as a historical preopen server receipt.
    """
    _day(signal_date); opening = instant(next_open); reasons = []
    cutoffs = entry['training_receipts']
    if not cutoffs or set(cutoffs) != set(entry['trainable_components']):
        raise ValueError('training_receipt_inventory_incomplete')
    for name, receipt in cutoffs.items():
        verify(receipt)
        if receipt.get('component_checksum') != entry['components'][name]:
            raise ValueError('training_receipt_component_mismatch')
        signal_max = _day(receipt['signal_date_max'])
        known_max = _day(receipt['label_known_at_max'])
        ancestor = _day(receipt['ancestor_label_known_at_max'])
        if signal_max >= signal_date or known_max >= signal_date or ancestor >= signal_date:
            reasons.append(name + ':training_or_ancestor_not_before_signal')
        if signal_max > known_max or not receipt.get('feature_vintage'):
            raise ValueError('training_receipt_dates_or_vintage_invalid')
        instant(receipt['actual_trained_at'])
    verify(input_evidence)
    if input_evidence['signal_date'] != signal_date:
        raise ValueError('input_evidence_date_mismatch')
    if input_evidence.get('reconstruction_verified') is not True:
        reasons.append('input_reconstruction_unverified')
    if not input_evidence.get('source_receipt_shas'):
        reasons.append('input_source_receipts_missing')
    if instant(input_evidence['latest_source_available_at']) >= opening:
        reasons.append('input_not_available_before_open')
    if instant(input_evidence['hmm_computed_at']) >= opening:
        reasons.append('hmm_computed_after_open')
    for incident in incidents:
        verify(incident)
        if incident['signal_date'] != signal_date:
            raise ValueError('incident_date_mismatch')
        if incident.get('reconstruction_verified') is not True or not incident.get('source_receipt_shas'):
            reasons.append('incident_unresolved:' + incident['incident_id'])
    return dict(eligible=not reasons, reasons=sorted(reasons),
                input_evidence_checksum=input_evidence['checksum'],
                incident_checksums=[i['checksum'] for i in incidents],
                training_receipt_checksums={k: v['checksum'] for k, v in cutoffs.items()},
                reconstruction_recorded_at=input_evidence['recorded_at'],
                evidence_kind=input_evidence['evidence_kind'])

def evaluate(*, registry, eligibility, observations, assessment_date, user_request_id):
    """All dates and accounts are supplied by immutable runtime receipts.

    Failed solves remain attempted days. Missing targets do not become zero
    performance. Retrospective receipts retain their actual recording clock.
    """
    if not user_request_id:
        raise ValueError('assessment_requires_user_request')
    _day(assessment_date)
    for record in (registry, eligibility):
        verify(record)
    rules_sha = digest(RULES)
    if registry['rules_sha'] != rules_sha or eligibility['rules_sha'] != rules_sha:
        raise ValueError('comparison_rules_changed')
    if eligibility['registry_checksum'] != registry['checksum']:
        raise ValueError('eligibility_registry_mismatch')
    entries = registry['entries']; champion = registry['champion_id']
    if champion not in entries:
        raise ValueError('champion_missing')
    challengers = [key for key in entries if key != champion]
    for key in challengers:
        if entries[key]['calibration'] not in CALIBRATION_ORDER:
            raise ValueError('calibration_unknown')
        component_changes(entries[key], entries[champion])
    calendar = eligibility['calendar']
    dates = [r['signal_date'] for r in calendar]
    if dates != sorted(set(dates)):
        raise ValueError('calendar_order_or_duplicate')
    by_date = {}
    for record in observations:
        verify(record)
        if (record['eligibility_checksum'] != eligibility['checksum']
                or instant(record['calculated_at']) < instant(eligibility['sealed_at'])):
            raise ValueError('performance_before_eligibility_seal')
        day = record['signal_date']
        if day in by_date or day not in dates or set(record['accounts']) != set(entries):
            raise ValueError('observation_scope_mismatch')
        by_date[day] = record
    eligible_by_id = {key: [] for key in entries}; common = []; pending = []; excluded = []
    for row in calendar:
        day = _day(row['signal_date'])
        if set(row['accounts']) != set(entries):
            raise ValueError('eligibility_accounts_mismatch')
        if day > assessment_date or _day(row['label_known_at_max']) > assessment_date:
            pending.append(day); continue
        for key, qualification in row['accounts'].items():
            if qualification['eligible'] is True:
                eligible_by_id[key].append(day)
        if all(row['accounts'][k]['eligible'] is True for k in entries):
            common.append(day)
        else:
            excluded.append({'signal_date': day, 'accounts': row['accounts']})
    # Keep the calendar axis even when eligibility excludes an intermediate day.
    axis = [d for d in dates if d <= assessment_date and d not in pending]
    result = dict(rules_sha=rules_sha, registry_checksum=registry['checksum'],
                  eligibility_checksum=eligibility['checksum'], assessment_date=assessment_date,
                  user_request_id=user_request_id, champion_id=champion,
                  challenger_count=len(challengers), eligible_dates_by_id=eligible_by_id,
                  eligible_counts={k: len(v) for k, v in eligible_by_id.items()},
                  common_eligible_dates=common, exclusions=excluded, pending=pending,
                  promotion_allowed=False, user_decision_required=True)
    missing = [d for d in common if d not in by_date]
    if missing:
        return {**result, 'status': 'incomplete_observations', 'missing_dates': missing, 'selected_id': None}
    scores = {k: [] for k in entries}; failures = []; holds = {}
    for key in entries:
        age_value = value = 0.; solved = 0; holding_complete = True
        for day in axis:
            if day not in common:
                scores[key].append(None); continue
            row = by_date[day]['accounts'][key]
            if row.get('target_weight_timing') != 'preopen_targets':
                raise ValueError('target_weight_timing_invalid')
            if row.get('solve_success') is True:
                solved += 1
            else:
                failures.append({'signal_date': day, 'account': key})
            exposure = row.get('exposure'); score = row.get('primary')
            if exposure == 0 and score is not None:
                raise ValueError('zero_exposure_must_be_missing')
            if score is not None and (not finite(score) or not finite(exposure) or exposure <= 0
                                      or not row.get('target_receipt_sha')):
                raise ValueError('primary_receipt_or_exposure_invalid')
            if row.get('solve_success') is not True and score is not None:
                raise ValueError('failed_solver_has_performance')
            scores[key].append(score)
            n, d = row.get('target_holding_age_value_sum'), row.get('target_holding_market_value')
            if not finite(n) or not finite(d) or n < 0 or d < 0 or (d == 0 and n != 0):
                holding_complete = False
            else:
                age_value += n; value += d
        holds[key] = {'solve_rate': solved / len(common) if common else None,
                      'holding_days': age_value / value if holding_complete and value > 0 else None}
    comparisons = {key: paired_stats(difference(scores[key], scores[champion])) for key in challengers}
    result.update(comparisons_vs_champion=comparisons, operational=holds, failed_solves=failures)
    qualified = [k for k in challengers if comparisons[k]['n'] and comparisons[k]['mean'] > 0
                 and comparisons[k]['ci95'][1] >= 0]
    qualified.sort(key=lambda k: comparisons[k]['mean'], reverse=True)
    if not qualified:
        return {**result, 'status': 'retain_champion_no_qualified_candidate', 'selected_id': None}
    selected = qualified[0]; tie = None
    if len(qualified) > 1:
        runner = qualified[1]; tie = paired_stats(difference(scores[selected], scores[runner]))
        if tie['ci95'] and tie['ci95'][0] <= 0 <= tie['ci95'][1]:
            def simplicity(key):
                return (component_changes(entries[key], entries[champion]),
                        CALIBRATION_ORDER.index(entries[key]['calibration']))
            if simplicity(selected) == simplicity(runner):
                return {**result, 'status': 'unresolved_equal_simplicity', 'selected_id': None,
                        'tied_ids': [selected, runner], 'top_two_comparison': tie}
            selected = min((selected, runner), key=simplicity)
    pool = paired_stats(scores[selected]); left, right = holds[selected], holds[champion]
    gates = {'beat_pool': finite(pool['mean']) and pool['mean'] > 0,
             'solve_rate': finite(left['solve_rate']) and finite(right['solve_rate']) and left['solve_rate'] >= right['solve_rate'],
             'holding_period': finite(left['holding_days']) and finite(right['holding_days']) and left['holding_days'] >= right['holding_days']}
    status = ('recommend_user_decision' if all(gates.values()) else
              'L4 選股未勝過候選池平均' if not gates['beat_pool'] else 'retain_champion_operational_gate_failed')
    return {**result, 'status': status, 'selected_id': selected, 'best_mean_id': qualified[0],
            'top_two_comparison': tie, 'selected_vs_pool': pool, 'gates': gates}
