"""Explicit pre-observation activation sealing. Never promotes a live model."""
from datetime import datetime, timezone
from pathlib import Path
import hashlib
from services.paired_nav_journal import digest
from services.l4_r17_session import publish

ENGINEERING_CHECKS=('native_full_session','four_arm_allocation_identity',
                    'formal_input_binding','failed_day_continuity')


def engineering_verified(evidence,code,owner):
    # State each verified scope separately. Archived input binding and synthetic
    # full sessions are not a prospective historical-market execution replay.
    return (evidence.get('status')=='passed'
        and evidence.get('implementation_checksum')==code
        and evidence.get('execution_owner')==owner
        and bool(evidence.get('test_receipts'))
        and all(evidence.get('checks',{}).get(k) is True for k in ENGINEERING_CHECKS))


def implementation_identity():
    root=Path(__file__).parent
    names=sorted(p.name for p in root.glob('l4_r17_*.py'))
    names+=['l4_r16_allocation.py','l4_private_execution.py','l4_native_observation.py',
            'l4_distribution_runtime.py']
    return digest({name:hashlib.sha256((root/name).read_bytes()).hexdigest() for name in names})


def seal_activation(*,objects,setup,engineering_ref,experiment,first_signal_date,first_session_date,
                    model_checksum,runner=None,now=None):
    from services.l4_r17_runtime import RULES_SHA,TIMING_SHA,load_activation
    from services.native_paper_sandbox import native_execution_identity,native_runtime_manifest
    from services.l4_native_observation import read_reference
    from services.l4_distribution import digest as model_digest
    clock=now or datetime.now(timezone.utc)
    if clock.tzinfo is None or first_session_date<=first_signal_date:
        raise ValueError('r17_activation_calendar')
    code=implementation_identity();owner=native_execution_identity(runner)
    if setup['configuration'].get('commission_contract')!=native_runtime_manifest(runner)['commission_contract']:
        raise ValueError('r17_native_commission_contract_missing_or_changed')
    engineering=objects.get(engineering_ref)
    if not engineering_verified(engineering,code,owner):
        raise ValueError('r17_engineering_incomplete')
    # Freeze and verify all inference dependencies before any prospective day.
    assets={name:read_reference(objects.bucket,setup['forecast_config'][name])
            for name in ('bundle','upstream','head','calibration','baseline')}
    bundle=assets['bundle']
    if (bundle['checksum']!=model_checksum or bundle['production_enabled'] is not False
            or bundle['upstream_checksum']!=model_digest(assets['upstream'])
            or bundle['head_checksum']!=model_digest(assets['head'])
            or bundle['calibration_checksum']!=model_digest(assets['calibration'])
            or setup['allocation_policy']['artifact']!=assets['baseline']):
        raise ValueError('r17_activation_frozen_dependency')
    for seed in bundle['seeds']:
        ref=seed['weights'];raw=objects.bucket.blob(ref['path']).download_as_bytes()
        if hashlib.sha256(raw).hexdigest()!=ref['sha256']:raise ValueError('r17_activation_weight_checksum')
    if setup['forecast_config']['native_observer']['l3_identity']!=assets['baseline']['l3_identity']:
        raise ValueError('r17_activation_upstream_identity')
    bootstrap=objects.get(setup['bootstrap_ref'])
    bootstrap_header=getattr(objects,'get_header',objects.get)(setup['bootstrap_ref'])
    body={'schema':'r17-p4-activation-v1','experiment':experiment,
        'identity':{'kind':'r17-p4-activation-v1','experiment':experiment},
        'sealed_at':clock.isoformat(),'rules_sha':RULES_SHA,'weight_timing_sha':TIMING_SHA,
        'primary_weight_sample':'preopen_sealed_targets','model_checksum':model_checksum,
        'first_signal_date':first_signal_date,'first_session_date':first_session_date,
        'engineering_ref':engineering_ref,'engineering_verified':True,
        'implementation_checksum':code,'execution_owner':owner,'setup_ref':objects.put(setup),
        'configuration_checksum':digest(setup['configuration']),
        'bootstrap_checksum':digest(bootstrap),'bootstrap_header_checksum':digest(bootstrap_header),
        'production_effect':False,'online_switch_allowed':False}
    body['checksum']=digest(body)
    ref=publish(objects,body['identity'],body)
    load_activation(objects,ref,runner=runner)
    return {'status':'sealed','activation_ref':ref,'checksum':body['checksum'],'outer_credit':0,
            'production_effect':False,'online_switch_allowed':False}
