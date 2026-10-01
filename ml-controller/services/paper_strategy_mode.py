"""Explicit single-B Paper mode, bound to the released residual artifact."""
from datetime import datetime,timezone,timedelta
from services.l4_distribution import validate_bundle,digest

MODE='single_b_tabpack_v1'
STATUS='disabled_by_single_b_policy'

def single_b_policy(config,*,signal_date=None):
    policy=(config or {}).get('l4Distribution') or {}
    mode=policy.get('operating_mode')
    if mode is None:return None
    if mode!=MODE or policy.get('strategy_role')!='B' or policy.get('scope')!='paper':
        raise ValueError('paper_single_b_mode_invalid')
    artifact=policy.get('artifact') or {};model=artifact.get('model') or {}
    if model.get('residual_mlp') is not None or not model.get('residual_tabpack'):
        raise ValueError('paper_single_b_tabpack_required')
    day=signal_date or datetime.now(timezone(timedelta(hours=8))).date().isoformat()
    validate_bundle(artifact,l3_identity=artifact.get('l3_identity'),signal_date=day)
    return {'mode':MODE,'strategy_role':'B','model_checksum':artifact['model_checksum'],
            'l3_identity':artifact['l3_identity'],'configuration_checksum':digest(config)}

def from_manifest(manifest,*,signal_date):
    receipt=((manifest or {}).get('active8_nav_inference') or {}).get('publication_receipt') or {}
    config=((receipt.get('paper_admission') or {}).get('configuration') or {}).get('trading_config')
    return single_b_policy(config,signal_date=signal_date)

def disabled_receipt(mode,*,signal_date,snapshot_id=None):
    if mode.get('mode')!=MODE:raise ValueError('paper_single_b_receipt_mode_invalid')
    result={'status':STATUS,'signal_date':signal_date,'paper_strategy':mode,
        'reason':'operator_selected_single_B_paper_strategy','retained_history':True,
        'paired_accounts_executed':0,'nav_maturity_credit':0,'promotion_allowed':False}
    if snapshot_id is not None:result['snapshot_id']=snapshot_id
    result['receipt_checksum']=digest(result)
    return result

def valid_disabled_receipt(value):
    if not isinstance(value,dict) or value.get('status')!=STATUS:return False
    mode=value.get('paper_strategy') or {}
    return (mode.get('mode')==MODE and mode.get('strategy_role')=='B'
        and len(mode.get('model_checksum',''))==64 and len(mode.get('configuration_checksum',''))==64
        and value.get('paired_accounts_executed')==0 and value.get('retained_history') is True
        and value.get('nav_maturity_credit')==0 and value.get('promotion_allowed') is False
        and value.get('receipt_checksum')==digest({k:v for k,v in value.items() if k!='receipt_checksum'}))
