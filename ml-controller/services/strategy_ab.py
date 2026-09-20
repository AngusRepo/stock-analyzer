"""Accepted A/B identities and fee reporting; no promotion or cash authority."""
from copy import deepcopy
from datetime import date
import re

from services.paired_nav_journal import digest, number

SCHEMA = 'strategy-ab-price-threehead-exo-mlp-v1'
RECIPES = {'A':'price_timexer_three_head', 'B':'exo137_timexer_three_head_scalar_ev_mlp'}
FEE_TERMS = {'discount_factor':.25, 'minimum_net_commission':20.,
             'nominal_next_month_day':10, 'cash_credit':'confirmed_receipt_only',
             'tax_and_slippage_rebated':False}


def validate_tag(tag):
    if (not isinstance(tag,dict) or tag.get('schema_version') != SCHEMA
            or tag.get('role') not in RECIPES
            or tag.get('recipe') != RECIPES[tag['role']]
            or not re.fullmatch('[a-f0-9]{64}',str(tag.get('experiment_id','')))
            or tag.get('fee_terms') != FEE_TERMS):
        raise ValueError('strategy_ab_identity_invalid')
    return tag


def bind(bundle, *, role, experiment_id, ensemble, timexer_metadata):
    from services.alpha_model_roster import TIMEXER_MODELS, validate_order
    from services.timexer_contract import metadata_contract
    from services.paired_nav_strategy_bundle import validate_strategy_bundle
    if role not in RECIPES or validate_order(ensemble['model_order']) != TIMEXER_MODELS:
        raise ValueError('strategy_ab_exact_eight_required')
    if ensemble['payload_checksum'] != bundle['candidate_l3_identity']['payload_checksum']:
        raise ValueError('strategy_ab_l3_identity_mismatch')
    config = metadata_contract(timexer_metadata)
    expected = ensemble['observation_artifacts']['TimeXer']
    if (expected['checksum'] != timexer_metadata.get('checksum')
            or expected['version'] != timexer_metadata.get('version')
            or config['variant'] != ('price' if role == 'A' else 'exo137')):
        raise ValueError('strategy_ab_timexer_variant_or_identity_mismatch')
    model = bundle['candidate_trading_config']['l4Distribution']['artifact']['model']
    if bool(model.get('residual_mlp')) != (role == 'B'):
        raise ValueError('strategy_ab_l4_recipe_mismatch')
    result = deepcopy(bundle)
    result['strategy_ab'] = validate_tag({'schema_version':SCHEMA,'experiment_id':experiment_id,
        'role':role,'recipe':RECIPES[role],'fee_terms':deepcopy(FEE_TERMS)})
    result['bundle_checksum'] = digest({k:v for k,v in result.items() if k != 'bundle_checksum'})
    return validate_strategy_bundle(result,signal_date=result['declared_signal_date'])


def accrue(previous, fills, *, session_date):
    """Accrual display only: a scheduled date never becomes spendable cash."""
    date.fromisoformat(session_date)
    old = previous.get('commission_rebate')
    if old is not None and (old.get('fee_terms') != FEE_TERMS or old.get('confirmed_received') != 0):
        raise ValueError('strategy_ab_rebate_history_requires_reconciliation')
    months = deepcopy((old or {}).get('months') or {})
    for fill in fills:
        charged = number(fill['commission'],'rebate.commission',minimum=0)
        value = max(0., charged-max(20.,charged*.25))
        key = session_date[:7]
        year, month = map(int,key.split('-'))
        row = months.setdefault(key,{'estimated_receivable':0.,'charged_commission':0.,
            'nominal_payment_date':f'{year+(month==12):04d}-{month%12+1:02d}-10'})
        row['estimated_receivable'] += value
        row['charged_commission'] += charged
    return {'fee_terms':deepcopy(FEE_TERMS),'months':months,
        'estimated_receivable':sum(row['estimated_receivable'] for row in months.values()),
        'confirmed_received':0.,'cash_credit':0.,'accounting':'accrual_estimate_separate_from_cash_nav'}


def bind_pair(primary, challenger, *, ensembles, timexer_metadata):
    """Freeze both recipes against one declared market/risk baseline."""
    if set(ensembles) != {'A','B'} or set(timexer_metadata) != {'A','B'}:
        raise ValueError('strategy_ab_two_artifacts_required')
    for key in ('declared_signal_date','baseline_l3_identity','baseline_trading_config'):
        if primary[key] != challenger[key]:
            raise ValueError('strategy_ab_unmatched_baseline:'+key)
    if primary['candidate_l3_identity'] == challenger['candidate_l3_identity']:
        raise ValueError('strategy_ab_distinct_l3_variants_required')
    identifier=digest({'schema_version':SCHEMA,'A':primary['bundle_checksum'],
                       'B':challenger['bundle_checksum'],'fee_terms':FEE_TERMS})
    return {role:bind(bundle,role=role,experiment_id=identifier,
                     ensemble=ensembles[role],timexer_metadata=timexer_metadata[role])
            for role,bundle in (('A',primary),('B',challenger))}
