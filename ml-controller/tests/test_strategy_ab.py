from copy import deepcopy
import pytest
from services.strategy_ab import accrue, validate_tag, FEE_TERMS, SCHEMA, RECIPES


def test_confirmed_minimum_and_payment_date_never_credit_unreceived_cash():
    first = accrue({},[{'commission':40},{'commission':20},{'commission':100}],session_date='2026-09-21')
    assert first['estimated_receivable'] == 95
    assert first['cash_credit'] == first['confirmed_received'] == 0
    assert first['months']['2026-09']['nominal_payment_date'] == '2026-10-10'
    next_month = accrue({'commission_rebate':first},[],session_date='2026-10-12')
    assert next_month == first  # Passing the nominal date is not a receipt.
    december = accrue({},[{'commission':40}],session_date='2026-12-31')
    assert december['months']['2026-12']['nominal_payment_date'] == '2027-01-10'


@pytest.mark.parametrize('role',['A','B'])
def test_frozen_strategy_labels_cannot_swap_recipe_or_fee_terms(role):
    tag = {'schema_version':SCHEMA,'role':role,'recipe':RECIPES[role],
           'experiment_id':'a'*64,'fee_terms':deepcopy(FEE_TERMS)}
    validate_tag(tag)
    tag['fee_terms']['minimum_net_commission'] = 5
    with pytest.raises(ValueError,match='identity_invalid'):
        validate_tag(tag)


@pytest.mark.parametrize('schema',['active8-release-model-profiles-v4-timexer-price',
                                  'active8-release-model-profiles-v4-timexer-exo137'])
def test_timeXer_release_profiles_complete_exact_eight_artifact_receipts(schema):
    from services.active8_release_training_contract import (build_release_training_contract,
        build_model_training_config_attestation,validate_release_artifact_receipts,normalize_release_execution_scope)
    from services.active8_release_model_profiles import model_profile,release_model_payload
    contract = build_release_training_contract(run_date='2026-09-18',
        dataset_snapshot={'snapshot_id':'frozen','business_date':'2026-09-18'},
        producer_source_sha='a'*40,model_profile_schema_version=schema)
    assert len(contract['models']) == 8 and 'DLinear' not in contract['models']
    assert release_model_payload('TimeXer',schema_version=schema)['exogenous'] == schema.endswith('exo137')
    assert normalize_release_execution_scope(['tree','timexer'],[],model_profile_schema_version=schema)[0] == ['tree','timexer','patchtst']
    receipts = {}
    for model in contract['models']:
        attestation = build_model_training_config_attestation(contract=contract,model_name=model,
            effective_config=model_profile(model,schema_version=schema)['required_effective_config'])
        receipts[model] = {'version':'frozen','artifact_path':model+'/model','metadata_path':model+'/metadata',
            'checksum':'b'*64,'metadata':{'version':'frozen','artifact_path':model+'/model',
            'checksum':'b'*64,'model_training_config_attestation':attestation}}
    assert validate_release_artifact_receipts(contract=contract,receipts=receipts)['models_completed'] == 8
    receipts['DLinear'] = receipts['TimeXer']
    with pytest.raises(ValueError,match='model_set_mismatch'):
        validate_release_artifact_receipts(contract=contract,receipts=receipts)


@pytest.mark.parametrize('role,expected', [('A','nav_eligible'),('B','comparison_only')])
def test_reviewed_role_controls_publication_without_rewriting_comparison(role, expected):
    from test_paired_nav_strategy_bundle import fixture_bundle, reseal, DAY
    from services.strategy_ab import publication_policy
    bundle, config, _ = fixture_bundle()
    bundle['strategy_ab'] = {'schema_version':SCHEMA, 'role':role, 'recipe':RECIPES[role],
        'experiment_id':'a'*64, 'fee_terms':deepcopy(FEE_TERMS)}
    reseal(bundle)
    before = deepcopy(config)
    assert publication_policy(config, signal_date=DAY) == expected
    assert config == before
    bundle['strategy_ab']['role'] = 'A' if role == 'B' else 'B'
    with pytest.raises(ValueError):
        publication_policy(config, signal_date=DAY)


def test_old_untagged_comparisons_keep_original_nav_authority():
    from services.strategy_ab import publication_policy
    assert publication_policy({'trading_config':{}}, signal_date='2026-09-21') == 'nav_eligible'
