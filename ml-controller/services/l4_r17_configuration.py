"""Private execution identities for R17; allocator policy itself is unchanged."""
from copy import deepcopy
from services.l4_distribution import digest
from services.l4_distribution_runtime import distribution_policy_identity

NAMES={'A':'raw','B':'linear','C':'empirical_bayes','L':'incumbent'}

def arm_trading_config(trading_config,*,allocation_policy,forecast,arm):
    name=NAMES[arm];baseline=allocation_policy['artifact']
    checksum=baseline['model_checksum'] if arm=='L' else forecast['model_checksum']
    binding=allocation_policy['r16_binding']
    if any(binding.get(k)!=forecast[k] for k in ('model_checksum','upstream_checksum','calibration_checksum')):
        raise ValueError('r17_configuration_frozen_binding')
    policy_id=digest(dict(base_policy_identity=distribution_policy_identity(allocation_policy,baseline['l3_identity']),
        r16_model=checksum,frozen_binding=binding,comparison_arm=name))
    cfg=deepcopy(trading_config)
    p={k:deepcopy(v) for k,v in allocation_policy.items() if k not in
       {'runtime','_account_rewards','artifact','operating_mode','strategy_role'}}
    # Worker needs an execution identity, not the baseline neural model relabeled
    # with the candidate hash. We deliberately do not copy model or release data.
    p['artifact']={k:deepcopy(baseline[k]) for k in ('schema_version','feature_schema','l3_identity')}
    # v4's original Worker validator checks the ordered TimeXer coordinates.
    # Carry that structural metadata only, never incumbent weights or PASS.
    p['artifact']['model']={'recipe':{'names':deepcopy(baseline['model']['recipe']['names'])}}
    p['artifact'].update(model_checksum=checksum,private_execution_identity=True,
        model_bundle_checksum=forecast['model_checksum'],comparison_arm=name)
    p['scope']='private_research'
    p['opb']={**p.get('opb',{'enabled':False}),'approved_policy_identity':policy_id}
    cfg['l4Distribution']=p
    return cfg

def configurations(trading_config,*,allocation_policy,forecast):
    return {a:arm_trading_config(trading_config,allocation_policy=allocation_policy,forecast=forecast,arm=a) for a in NAMES}
