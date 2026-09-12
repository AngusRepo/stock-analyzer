from copy import deepcopy

import pytest

from services.paired_native_registration import validate_carry_context
from services.paired_nav_journal import digest


def fixture():
    allocation = dict(pair_id='pair', candidate_checksum='c' * 64, baseline_checksum='b' * 64,
                      configuration={'trading_config': {'fees': {'commission': .001425}},
                                     'risk_config': {'maxPosition': .2}})
    kwargs = dict(allocation=allocation, runtime={'execution_owner_version': 'native-v1'},
                  account_id=1, variables={'FINLAB_L5_MARKET_DATA_ENABLED': '1'},
                  kv_read_policy={'source': ['holiday:']},
                  source_context={'observed_at': '2026-09-08T00:00:00Z',
                                  'frozen_kv': {'ml:config': '{"exit": true}'}})
    previous = {k: allocation[k] for k in ('pair_id', 'candidate_checksum', 'baseline_checksum')}
    previous.update({k: kwargs[k] for k in ('account_id', 'variables', 'kv_read_policy', 'source_context')})
    previous['execution_owner_version'] = 'native-v1'
    previous['configuration_checksum'] = digest({**allocation['configuration'],
        'fees': allocation['configuration']['trading_config']['fees']})
    return deepcopy(previous), deepcopy(kwargs)


@pytest.mark.parametrize('field', ['account_id', 'variables', 'candidate_checksum', 'baseline_checksum',
                                  'execution_owner_version', 'configuration', 'kv_read_policy', 'frozen_kv'])
def test_no_silent_cross_day_experiment_change(field):
    previous, kwargs = fixture()
    if field in ('candidate_checksum', 'baseline_checksum'):
        kwargs['allocation'][field] = 'e' * 64
    elif field == 'execution_owner_version':
        kwargs['runtime'][field] = 'native-v2'
    elif field == 'configuration':
        kwargs['allocation']['configuration']['risk_config']['maxPosition'] = .3
    elif field == 'frozen_kv':
        kwargs['source_context']['frozen_kv']['ml:config'] = '{"exit": false}'
    elif field == 'account_id':
        kwargs[field] = 2
    else:
        kwargs[field] = {}
    with pytest.raises(ValueError, match='carry_context_changed:' + field):
        validate_carry_context(previous, **kwargs)


def test_new_capture_clock_and_equivalent_json_do_not_reset_nav():
    previous, kwargs = fixture()
    kwargs['source_context']['observed_at'] = '2026-09-09T00:00:00Z'
    kwargs['source_context']['frozen_kv']['ml:config'] = '{ "exit" : true }'
    validate_carry_context(previous, **kwargs)


def test_invalid_policy_json_cannot_be_ignored():
    previous, kwargs = fixture()
    kwargs['source_context']['frozen_kv']['ml:config'] = 'invalid'
    with pytest.raises(ValueError):
        validate_carry_context(previous, **kwargs)
