"""Evidence-bound three-policy account comparison; no fitting or activation."""
from datetime import date
from services.l4_distribution import digest, finite

SCHEMA = 'l4-paired-incremental-comparison-v2'
ROLES = ('candidate', 'incumbent', 'l3_same_allocator')
COMMON = ('pool_checksum', 'calendar_checksum', 'initial_account_checksum',
          'costs_checksum', 'risk_constraints_checksum', 'market_data_checksum')
MATCHED_L3 = ('allocator_checksum', 'opb_protocol_checksum', 'execution_checksum')


def checksum(value, field):
    if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
        raise ValueError('l4_comparison_checksum_invalid:' + field)
    return value


def account_metrics(run):
    if run.get('complete') is not True or run.get('accounting') != 'cash_plus_marked_holdings_after_costs':
        raise ValueError('l4_comparison_account_incomplete')
    if run.get('external_cash_flows') != 'none':
        raise ValueError('l4_comparison_cash_flows_unsupported')
    initial = finite(run.get('initial_nav'), 'initial_nav')
    if initial <= 0:
        raise ValueError('l4_comparison_initial_nav_invalid')
    curve = run.get('daily_nav')
    if not isinstance(curve, list) or not curve:
        raise ValueError('l4_comparison_nav_missing')
    days = [row['date'] for row in curve]
    if days != sorted(set(days)):
        raise ValueError('l4_comparison_calendar_invalid')
    peak, drawdown = initial, 0.
    for row in curve:
        date.fromisoformat(row['date'])
        nav = finite(row.get('nav'), 'marked_nav')
        cash = finite(row.get('cash'), 'cash')
        holdings = finite(row.get('holdings_market_value'), 'holdings_market_value')
        if nav <= 0 or holdings < 0 or abs(nav - cash - holdings) > max(1e-8,nav*1e-10):
            raise ValueError('l4_comparison_nav_accounting_mismatch')
        peak = max(peak, nav)
        drawdown = max(drawdown, 1 - nav / peak)
    return {'net_return':nav / initial - 1, 'max_drawdown':drawdown, 'dates':days}


def build_comparison(runs, protocol, *, candidate_model_checksum, l3_identity_checksum):
    if not isinstance(runs,dict) or set(runs) != set(ROLES):
        raise ValueError('l4_comparison_l3_and_incumbent_required')
    checksum(candidate_model_checksum, 'candidate_model')
    checksum(l3_identity_checksum, 'l3_identity')
    if (protocol.get('scope') != 'paired_native_paper_execution'
            or protocol.get('holdout_usage') != 'untouched_after_selection'
            or protocol.get('preselection') is not False):
        raise ValueError('l4_comparison_protocol_invalid')
    freeze = date.fromisoformat(protocol['selection_frozen_before'])
    signal_dates = protocol.get('signal_dates') or []
    if (not signal_dates or signal_dates != sorted(set(signal_dates))
            or freeze >= date.fromisoformat(signal_dates[0])):
        raise ValueError('l4_comparison_selection_leakage')
    for day in signal_dates:
        date.fromisoformat(day)
    metric = {role:account_metrics(run) for role,run in runs.items()}
    reference = runs['candidate']
    if reference.get('model_checksum') != candidate_model_checksum:
        raise ValueError('l4_comparison_candidate_identity_mismatch')
    if (runs['l3_same_allocator'].get('prediction_policy') != 'native_l3_mean_no_correction'
            or runs['l3_same_allocator'].get('l3_identity_checksum') != l3_identity_checksum
            or reference.get('l3_identity_checksum') != l3_identity_checksum):
        raise ValueError('l4_comparison_native_l3_baseline_required')
    for role,run in runs.items():
        checksum(run.get('ledger_checksum'), role + ':ledger')
        checksum(run.get('model_checksum'), role + ':model')
        for key in COMMON + MATCHED_L3:
            checksum(run.get(key), role + ':' + key)
        if (run['initial_nav'] != reference['initial_nav']
                or metric[role]['dates'] != metric['candidate']['dates']
                or any(run[k] != reference[k] for k in COMMON)):
            raise ValueError('l4_comparison_shared_inputs_mismatch')
    if not set(signal_dates) <= set(metric['candidate']['dates']):
        raise ValueError('l4_comparison_signal_calendar_mismatch')
    if any(runs['l3_same_allocator'][k] != reference[k] for k in MATCHED_L3):
        raise ValueError('l4_comparison_l3_allocator_mismatch')
    maximum = finite(protocol.get('max_allowed_drawdown'), 'max_allowed_drawdown')
    if not 0 <= maximum <= 1:
        raise ValueError('l4_comparison_drawdown_budget_invalid')
    improvements = {role:metric['candidate']['net_return']-metric[role]['net_return']
                    for role in ('incumbent','l3_same_allocator')}
    return {'schema_version':SCHEMA, 'complete':True,
        'candidate_model_checksum':candidate_model_checksum, 'l3_identity_checksum':l3_identity_checksum,
        'protocol':protocol, 'runs':runs, 'metrics':metric,
        'net_return_improvement':improvements,
        'passes':all(v > 0 for v in improvements.values()) and metric['candidate']['max_drawdown'] <= maximum,
        'efficacy_claim':'observed_paired_improvement_not_statistical_significance',
        'evidence_checksum':digest({'runs':runs,'protocol':protocol})}


def validate_comparison(result, bundle):
    if not isinstance(result,dict) or result.get('schema_version') != SCHEMA:
        raise ValueError('l4_distribution_paired_l3_comparison_missing')
    if bundle.get('training_label_known_max','9999-12-31') >= min((result.get('protocol') or {}).get('signal_dates') or ['0001-01-01']):
        raise ValueError('l4_comparison_selection_leakage')
    expected = build_comparison(result.get('runs'),result.get('protocol') or {},
        candidate_model_checksum=bundle['model_checksum'],l3_identity_checksum=digest(bundle['l3_identity']))
    if result != expected:
        raise ValueError('l4_distribution_paired_comparison_tampered')
    if not expected['passes']:
        raise ValueError('l4_distribution_paired_acceptance_failed')
