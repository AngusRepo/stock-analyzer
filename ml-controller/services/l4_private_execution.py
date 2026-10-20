"""Pure new-L4 evaluation inside the same transactional private Paper host."""
import base64
import hashlib
import json
from copy import deepcopy
from services.l4_distribution import digest
from services.l4_distribution_runtime import run


def legacy_weight_references(bundle):
    """External legacy TabPack objects only; inline and P6 models have none."""
    from services.l4_tabpack_median import SCHEMA as MEDIAN_SCHEMA
    from services.l4_tabpack_weights import SCHEMA, validate_reference
    model = bundle.get('model', {}).get('residual_tabpack') or {}
    packs = ([member['model'] for member in model['members']]
             if model.get('schema_version') == MEDIAN_SCHEMA else [model])
    refs = {}
    for pack in packs:
        if pack.get('schema_version') != SCHEMA:
            continue
        ref = pack['weights']
        validate_reference(ref)
        if ref['path'] in refs and refs[ref['path']] != ref:
            raise ValueError('private_legacy_weight_reference_changed')
        refs[ref['path']] = ref
    return refs


def frozen_legacy_loader(inputs, bundle):
    """Require every legacy weight locally, without permitting a live fallback."""
    refs = legacy_weight_references(bundle)
    objects = inputs.get('legacy_weight_objects') or {}
    if set(objects) != set(refs):
        raise ValueError('private_legacy_weight_inventory_missing')
    decoded = {}
    for path, ref in refs.items():
        obj = objects[path]
        if obj.get('reference') != ref:
            raise ValueError('private_legacy_weight_reference_changed')
        try:
            raw = base64.b64decode(obj['base64'], validate=True)
        except (ValueError, TypeError, KeyError) as exc:
            raise ValueError('private_legacy_weight_encoding_invalid') from exc
        if len(raw) != ref['bytes'] or hashlib.sha256(raw).hexdigest() != ref['sha256']:
            raise ValueError('private_legacy_weight_checksum_mismatch')
        decoded[path] = raw

    def load(ref):
        if refs.get(ref.get('path')) != ref:
            raise ValueError('private_legacy_weight_reference_changed')
        return decoded[ref['path']]
    # Even a no-weight private model must never fall through to live storage.
    return load


def frozen_p6_loader(inputs, bundle):
    """Private replay must carry the exact three weight objects, never read live storage."""
    from services.l4_p6_bundle import is_p6
    from services.l4_p6_weights import validate_reference
    if not is_p6(bundle):
        if inputs.get('p6_weight_objects') is not None:
            raise ValueError('private_l4_unexpected_p6_weights')
        return None
    objects=inputs.get('p6_weight_objects') or {}
    refs={seed['weights']['path']:seed['weights'] for seed in bundle['model']['seeds']}
    if set(objects)!=set(refs):raise ValueError('private_p6_weight_inventory_missing')
    decoded={}
    for path,ref in refs.items():
        validate_reference(ref)
        obj=objects[path]
        if obj.get('reference')!=ref:raise ValueError('private_p6_weight_reference_changed')
        try:raw=base64.b64decode(obj['base64'],validate=True)
        except (ValueError,TypeError,KeyError) as exc:raise ValueError('private_p6_weight_encoding_invalid') from exc
        if len(raw)!=ref['bytes'] or hashlib.sha256(raw).hexdigest()!=ref['sha256']:
            raise ValueError('private_p6_weight_checksum_mismatch')
        decoded[path]=raw
    def load(ref):
        if refs.get(ref.get('path'))!=ref:raise ValueError('private_p6_weight_reference_changed')
        return decoded[ref['path']]
    return load


def allocate_private(store,account):
    from services.recommendation_service import build_recommendation_update_statements
    if not store.in_frame or account.get('account_id')!=1 or account.get('complete') is not True:
        raise ValueError('private_l4_account_scope_invalid')
    raw=store.db.execute("SELECT value FROM _native_private_kv WHERE key='l4:private_allocation_inputs'").fetchone()
    if raw is None:raise ValueError('private_l4_frozen_inputs_missing')
    frozen=json.loads(raw[0]);inputs=deepcopy(frozen['inputs'])
    policy=inputs['alpha_policy']['l4Distribution']
    if account['signal_date']!=policy['runtime']['signal_date']:
        raise ValueError('private_l4_signal_mismatch')
    head=store.db.execute('SELECT plan_id FROM l4_portfolio_head_v1 WHERE account_id=1').fetchone()
    if account.get('active_plan_id')!=(head[0] if head else None):
        raise ValueError('private_l4_account_head_changed')
    policy['runtime']['account']=account
    ledger=[json.loads(row[0]) for row in store.db.execute('SELECT payload_json FROM l4_policy_account_rewards_v1 ORDER BY known_date,receipt_id')]
    weight_loader=frozen_p6_loader(inputs,policy['artifact'])
    legacy_loader=frozen_legacy_loader(inputs,policy['artifact'])
    captures = []
    shadow=inputs.get('r2_shadow')
    if shadow is not None:
        # This store is the isolated native Paper host. Production callers have
        # no packet parameter and cannot activate the research scope through KV.
        policy['scope']='private_research'
    from services.l4_tabpack_weights import private_weight_reader
    with private_weight_reader(legacy_loader):
        rows=run(inputs['recommendations'],policy,return_history=inputs['return_history'],reward_ledger=ledger,
            private_research=True, evidence_sink=captures.append,
            **({'r2_shadow':shadow} if shadow is not None else {}),
            **({'p6_weight_loader':weight_loader} if weight_loader is not None else {}))
    if len(captures) != 1:
        raise ValueError('private_l4_allocation_capture_missing')
    plan=captures[0]['portfolio_plan']
    if rows and rows[0].pop('_l4_portfolio_plan') != plan:
        raise ValueError('private_l4_allocation_plan_changed')
    # The exact native serializer; no independent execution or fill approximation.
    for sql,args in build_recommendation_update_statements(rows,account['signal_date']):
        if store.db.execute(sql,args).rowcount!=1:
            raise ValueError('private_l4_recommendation_update_incomplete')
    unsigned={k:v for k,v in plan.items() if k!='plan_id'}
    if digest(unsigned)!=plan['plan_id']:raise ValueError('private_l4_plan_checksum_invalid')
    return {'plan':plan,'canonical_payload':json.dumps(unsigned,sort_keys=True,separators=(',',':'),allow_nan=False),
            'allocation_snapshot_id':frozen['allocation_snapshot_id']}
