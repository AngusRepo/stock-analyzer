"""Narrow Paper model succession; immutable prior admission remains authoritative.

The approval pins complete current source vectors and execution identity. A new
model never inherits old policy rewards, NAV maturity, efficacy or a live gate.
"""
from copy import deepcopy
import hashlib
from pathlib import Path

from services.l4_distribution import digest, validate_bundle
from services.l4_distribution_runtime import distribution_policy_identity, choose_opb
from services.paper_strategy_mode import MLP_MODE, validate_model_mode

SCHEMA = 'l4-full-mlp-median-paper-cutover-v1'
SOURCE_FILES = {'l4_residual_mlp.py','l4_mlp_weights.py','l4_mlp_median.py','l4_distribution_runtime.py',
    'paper_strategy_mode.py','paired_nav_collection.py','l4_model_cutover.py',
    'active8_paper_admission.py','strategy_ab.py','paired_nav_recommendation_path.py'}


def validate_cutover(approval, *, admission, now):
    from services.active8_paper_admission import validate_runtime_approval
    from services.paired_nav_journal import digest as journal_digest
    from services.native_paper_sandbox import native_execution_identity
    prior=approval.get('prior_runtime_approval')
    if not isinstance(prior,dict) or prior.get('approved_full_mlp_champion_cutover') is not None:
        raise RuntimeError('l4_cutover_prior_runtime_required')
    validate_runtime_approval(prior,admission,now=now)
    grant=approval.get('approved_full_mlp_champion_cutover') or {}
    before,after=deepcopy(prior['configuration']),deepcopy(approval['configuration'])
    old,new=before['trading_config']['l4Distribution'],after['trading_config']['l4Distribution']
    if (grant.get('schema_version')!=SCHEMA or grant.get('scope')!='paper'
            or grant.get('maturity_transfer') is not False or grant.get('account_reset') is not False
            or grant.get('previous_configuration_checksum')!=journal_digest(prior['configuration'])
            or grant.get('next_configuration_checksum')!=journal_digest(approval['configuration'])
            or grant.get('previous_model_checksum')!=old['artifact']['model_checksum']
            or grant.get('next_model_checksum')!=new['artifact']['model_checksum']
            or new.get('operating_mode')!=MLP_MODE or new.get('strategy_role')!='B'
            or new.get('scope')!='paper' or old['artifact']['l3_identity']!=new['artifact']['l3_identity']):
        raise RuntimeError('l4_cutover_identity_invalid')
    validate_model_mode(new)
    validate_bundle(new['artifact'],l3_identity=new['artifact']['l3_identity'],signal_date=grant['signal_date'])
    release=new['artifact']['release']
    if release.get('acceptance_mode')!='paper_experiment' or release.get('efficacy_status')!='unproven':
        raise RuntimeError('l4_cutover_engineering_experiment_required')
    old_opb,new_opb=deepcopy(old.get('opb')),deepcopy(new.get('opb'))
    if not old_opb or not new_opb or not new_opb.get('enabled'):
        raise RuntimeError('l4_cutover_opb_required')
    identity=distribution_policy_identity(new,new['artifact']['l3_identity'])
    if new_opb.pop('approved_policy_identity',None)!=identity:
        raise RuntimeError('l4_cutover_opb_identity_invalid')
    old_opb.pop('approved_policy_identity',None)
    if old_opb!=new_opb or old['constraints']!=new['constraints']:
        raise RuntimeError('l4_cutover_allocator_policy_changed')
    old_static={k:v for k,v in old.items() if k not in ('artifact','operating_mode','strategy_role','opb')}
    new_static={k:v for k,v in new.items() if k not in ('artifact','operating_mode','strategy_role','opb')}
    if old_static!=new_static:
        raise RuntimeError('l4_cutover_unapproved_policy_fields')
    choose_opb(new,[],identity,grant['signal_date'])
    # Only the exact released model/mode and its new OPB identity may differ.
    before['trading_config']['l4Distribution']=deepcopy(new)
    for section in ('allocator_source_identity','l3_inference_source_identity'):
        old_sources,new_sources=before[section],after[section]
        for name in set(old_sources)|set(new_sources):
            if old_sources.get(name)==new_sources.get(name):continue
            path=Path(__file__).with_name(name)
            if (name not in SOURCE_FILES or name not in new_sources or not path.is_file()
                    or hashlib.sha256(path.read_bytes()).hexdigest()!=new_sources[name]):
                raise RuntimeError('l4_cutover_unreviewed_source_change:'+name)
        before[section]=deepcopy(new_sources)
    expected=native_execution_identity()
    if after['native_execution_policy'].get('execution_owner_version')!=expected:
        raise RuntimeError('l4_cutover_execution_identity_invalid')
    before['native_execution_policy']['execution_owner_version']=expected
    for flag in ('LIVE_EXECUTION_CLIENT_ENABLED','LIVE_EXECUTION_SUBMIT_GUARD_ENABLED'):
        if str(after['native_execution_policy']['variables'].get(flag,'')).lower() not in ('0','false','off','disabled'):
            raise RuntimeError('l4_cutover_live_execution_forbidden')
    if journal_digest(before)!=journal_digest(after):
        raise RuntimeError('l4_cutover_unapproved_configuration_change')
    return deepcopy(approval)
