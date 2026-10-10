"""Explicit single-B Paper mode, bound to the released residual artifact."""
from datetime import datetime,timezone,timedelta
from services.l4_distribution import validate_bundle,digest

MODE='single_b_tabpack_v1'
MLP_MODE='single_b_full_mlp_median_v1'
TABPACK_MEDIAN_MODE='single_b_tabpack_core16_median_v1'
MODES=(MODE,MLP_MODE,TABPACK_MEDIAN_MODE)
STATUS='disabled_by_single_b_policy'

def refresh_family(config):
    override=((config or {}).get('l4Distribution') or {}).get('candidate_model_family')
    if override is not None:
        if override not in ('tabpack', 'tabpack_median16', 'full_mlp_median'):
            raise ValueError('paper_candidate_model_family_invalid')
        return override
    mode=((config or {}).get('l4Distribution') or {}).get('operating_mode')
    return {MLP_MODE:'full_mlp_median',TABPACK_MEDIAN_MODE:'tabpack_median16'}.get(mode,'tabpack')

def is_single_b(policy):
    return (policy or {}).get('operating_mode') in MODES

def validate_model_mode(policy):
    model=((policy or {}).get('artifact') or {}).get('model') or {}
    mode=(policy or {}).get('operating_mode')
    if mode == MODE:
        if model.get('residual_mlp') is not None or not model.get('residual_tabpack'):
            raise ValueError('paper_single_b_tabpack_required')
    elif mode == TABPACK_MEDIAN_MODE:
        from services.l4_tabpack_median import SCHEMA
        if (model.get('residual_mlp') is not None
                or (model.get('residual_tabpack') or {}).get('schema_version') != SCHEMA):
            raise ValueError('paper_single_b_tabpack_core16_median_required')
    elif mode == MLP_MODE:
        from services.l4_mlp_median import SCHEMA
        mlp=model.get('residual_mlp') or {}
        if (model.get('residual_tabpack') is not None or mlp.get('schema_version') != SCHEMA
                or mlp.get('residual_multiplier') != 1.0):
            raise ValueError('paper_single_b_full_mlp_median_required')
    else:
        raise ValueError('paper_single_b_mode_invalid')

def single_b_policy(config,*,signal_date=None):
    policy=(config or {}).get('l4Distribution') or {}
    mode=policy.get('operating_mode')
    if mode is None:return None
    if mode not in MODES or policy.get('strategy_role')!='B' or policy.get('scope')!='paper':
        raise ValueError('paper_single_b_mode_invalid')
    artifact=policy.get('artifact') or {};model=artifact.get('model') or {}
    validate_model_mode(policy)
    day=signal_date or datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    validate_bundle(artifact,l3_identity=artifact.get('l3_identity'),signal_date=day)
    return {'mode':mode,'strategy_role':'B','model_checksum':artifact['model_checksum'],
            'l3_identity':artifact['l3_identity'],'configuration_checksum':digest(config)}

def from_manifest(manifest,*,signal_date):
    receipt=((manifest or {}).get('active8_nav_inference') or {}).get('publication_receipt') or {}
    config=((receipt.get('paper_admission') or {}).get('configuration') or {}).get('trading_config')
    return single_b_policy(config,signal_date=signal_date)

def disabled_receipt(mode,*,signal_date,snapshot_id=None):
    if mode.get('mode') not in MODES:raise ValueError('paper_single_b_receipt_mode_invalid')
    result={'status':STATUS,'signal_date':signal_date,'paper_strategy':mode,
        'reason':'operator_selected_single_B_paper_strategy','retained_history':True,
        'paired_accounts_executed':0,'nav_maturity_credit':0,'promotion_allowed':False}
    if snapshot_id is not None:result['snapshot_id']=snapshot_id
    result['receipt_checksum']=digest(result)
    return result

def valid_disabled_receipt(value):
    if not isinstance(value,dict) or value.get('status')!=STATUS:return False
    mode=value.get('paper_strategy') or {}
    return (mode.get('mode') in MODES and mode.get('strategy_role')=='B'
        and len(mode.get('model_checksum',''))==64 and len(mode.get('configuration_checksum',''))==64
        and value.get('paired_accounts_executed')==0 and value.get('retained_history') is True
        and value.get('nav_maturity_credit')==0 and value.get('promotion_allowed') is False
        and value.get('receipt_checksum')==digest({k:v for k,v in value.items() if k!='receipt_checksum'}))
