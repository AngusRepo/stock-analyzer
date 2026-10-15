"""Independent full-native L3 inference; never call a publication wrapper."""
SCOPE='l4-native-pool-observation-v1'


def run_reference(envelope,*,read,compute):
    import hashlib,json,re
    ref=envelope.get('request_reference') or {}
    if (set(envelope)!={'schema_version','request_reference'}
            or envelope.get('schema_version')!='l4-native-request-reference-v1'
            or not re.fullmatch(r'l4_distribution/forward_data/v1/native_requests/[0-9a-f]{64}\.json',ref.get('path',''))
            or not re.fullmatch(r'[0-9a-f]{64}',ref.get('sha256',''))):
        raise ValueError('l4_native_request_reference_invalid')
    raw=read(ref['path'])
    if hashlib.sha256(raw).hexdigest()!=ref['sha256']:
        raise ValueError('l4_native_request_hash')
    payload=json.loads(raw)
    payload['request_transport']={'schema_version':'l4-native-request-reference-v1','request_sha256':ref['sha256']}
    return run(payload,compute=compute)


def run(payload,*,compute):
    rows=payload.get('payloads') or []
    symbols=[r.get('symbol') for r in rows]
    if (payload.get('execution_scope')!=SCOPE or payload.get('max_symbols')!=5000
            or not 1<=len(rows)<=5000 or None in symbols or '' in symbols
            or len(symbols)!=len(set(symbols))
            or any(k in payload for k in ('callback_url','callback_token','paired_nav_l3_requests','paired_nav_atomic_slates'))):
        raise ValueError('l4_native_inference_scope_or_capacity')
    result=compute(payload)
    if result.get('schema_version')!='pipeline-modal-prediction-bundle-v1':
        raise ValueError('l4_native_inference_output_schema')
    result['execution_scope']=SCOPE
    elapsed=float(result.get('capacity_contract',{}).get('bundle_elapsed_sec') or 0)
    result['capacity_contract']={**result.get('capacity_contract',{}),
        'schema_version':'l4-native-observation-capacity-v1','max_symbols':5000,
        'bundle_timeout_sec':7200,'timeout_headroom_ratio':round(7200/elapsed,3) if elapsed>0 else None,
        'status':'healthy' if elapsed<=1800 else ('watch' if elapsed<=3600 else 'breached')}
    return result
