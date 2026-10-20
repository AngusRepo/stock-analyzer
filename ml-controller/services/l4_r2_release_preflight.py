"""Read-only release checks; no activation, model selection, or training."""
from services.l4_distribution import digest
from services.l4_native_observation import read_reference,validate_context
from services.l4_r2_shadow import validate
from services.l4_r2_forward_evaluation import validate_policy
from services.l4_r2_allocation import allocation_policy

def check(bucket,config,*,signal_date):
    learning=config['l4R2Learning'];observer=learning['native_observation'];shadow=learning['shadow']
    if (observer['classification']!=shadow['classification'] or observer['classification']!=learning['monthly']['classification']
            or config['l4Distribution'].get('candidate_model_family')!='tabpack_r2'):
        raise ValueError('l4_r2_release_configuration_incomplete')
    context=read_reference(bucket,observer['serving_context']);cutoffs=read_reference(bucket,observer['training_cutoffs'])
    records={r['model']:read_reference(bucket,r['reference']) for r in cutoffs['source_references']}
    known=validate_context(context,observer['l3_identity'],cutoffs,signal_date,records)
    from services.l4_native_l2_dependency import unused_timesfm_receipt
    if unused_timesfm_receipt(context) is None:
        raise ValueError('l4_release_model_feature_contract_unverified')
    baseline=read_reference(bucket,shadow['baseline']);bundle=read_reference(bucket,shadow['bundle'])
    policy=read_reference(bucket,shadow['evaluation_policy']);validate_policy(policy)
    from services.l4_r2_identity import implementation_identity
    if policy['implementation_checksum']!=implementation_identity()['checksum']:
        raise ValueError('l4_r2_release_implementation_changed')
    validate(bundle,identity=observer['l3_identity'],signal_date=signal_date)
    allocation=read_reference(bucket,policy['allocation_policy_reference']);cost=read_reference(bucket,policy['cost_policy_reference'])
    if (policy['model_checksum']!=bundle['payload_checksum'] or policy['baseline_model_checksum']!=baseline['model_checksum']
            or policy['head_policy']!=bundle['head_policy'] or baseline!=config['l4Distribution']['artifact']
            or allocation!=allocation_policy(config['l4Distribution']) or policy['allocation_policy_checksum']!=digest(allocation)
            or cost!=config['fees'] or policy['cost_policy_checksum']!=digest(cost)
            or allocation['constraints']['covariance_horizon_sessions']!=5
            or allocation['sealedExecution']['require_matched_risk_horizon'] is not True
            or signal_date<policy['first_signal_date']):
        raise ValueError('l4_r2_release_policy_drift')
    # Historical source classification stays fixed; each prospective roster uses
    # the complete dated official listing captured by the observer itself.
    classified=read_reference(bucket,observer['classification'])
    if not classified.get('accepted_evidence') or any(not r['cfi'].startswith(('ES','ED')) for r in classified['accepted_evidence'].values()):
        raise ValueError('l4_r2_release_classification_invalid')
    return dict(schema_version='l4-r2-release-preflight-v1',status='validated',l3_training_known_max=known,
        model_checksum=bundle['payload_checksum'],baseline_model_checksum=baseline['model_checksum'],
        policy_checksum=digest(policy),first_signal_date=policy['first_signal_date'],required_mature_days=20,
        risk_horizon_sessions=5,remote_execution_verified=False,production_enabled=False,
        training_started=False,promoted=False)
