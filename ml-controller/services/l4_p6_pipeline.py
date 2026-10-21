"""Full native inference universe for P6, preserving Router admission separately.

This runs during L3 input preparation, before the premarket serving handoff.
No NAV, training, research account, or independent second inference is invoked.
"""
from copy import deepcopy
import os
from services.l4_distribution import digest
from services.l4_p6_bundle import is_p6


def prepare_universe(state,*,bucket=None,roster_reader=None,catalog_reader=None):
    policy=(state.get('trading_config') or {}).get('l4Distribution') or {}
    if not is_p6(policy.get('artifact')):return {}
    day=state['run_date'];saved=state.get('p6_inference_universe')
    if saved is not None:
        validate_universe(saved,day,policy['artifact'])
        if state.get('active_stocks')!=saved['roster']:raise ValueError('p6_universe_retry_roster_changed')
        return dict(active_stocks=deepcopy(saved['roster']),p6_inference_universe=deepcopy(saved))
    if state.get('payload_source_observations') is not None:
        raise ValueError('p6_cannot_upgrade_captured_routed_pool')
    from services.l4_native_observation import daily_roster
    from services.l4_instrument_classification import capture,select
    roster,proof=(roster_reader or daily_roster)(day)
    if bucket is None and catalog_reader is None:
        from google.cloud import storage
        name=os.environ.get('GCS_BUCKET_NAME','').strip()
        if not name:raise ValueError('p6_universe_bucket_missing')
        bucket=storage.Client().bucket(name)
    catalog,reference=(catalog_reader or capture)(bucket,day)
    roster,classification,exclusions=select(roster,catalog,day)
    # Keep full preclassification model inputs; native OOF ranks are by market
    # before ETF exclusion. Only equity predictions enter P6 normalization.
    routed=sorted(r['symbol'] for r in state['active_stocks'])
    if set(routed)-{r['symbol'] for r in roster}:raise ValueError('p6_router_outside_verified_native_roster')
    body=dict(schema_version='p6-inference-universe-v1',signal_date=day,
        model_checksum=policy['artifact']['model_checksum'],l3_identity=policy['artifact']['l3_identity'],
        roster=roster,roster_proof=proof,classification=classification,classification_reference=reference,
        listing_exclusions=exclusions,routed_symbols=routed,
        route_admission_changed=False,second_inference_required=False)
    body={**body,'checksum':digest(body)}
    validate_universe(body,day,policy['artifact'])
    return dict(active_stocks=deepcopy(roster),p6_inference_universe=body)


def validate_universe(saved,day,bundle):
    if (saved.get('schema_version')!='p6-inference-universe-v1' or saved.get('signal_date')!=day
            or saved.get('checksum')!=digest({k:v for k,v in saved.items() if k!='checksum'})
            or saved.get('model_checksum')!=bundle['model_checksum']
            or saved.get('l3_identity')!=bundle['l3_identity']
            or saved.get('route_admission_changed') is not False
            or saved.get('second_inference_required') is not False
            or not saved.get('roster') or not saved.get('classification_reference')):
        raise ValueError('p6_inference_universe_binding')


def project_predictions(state,predictions,identity):
    policy=(state.get('trading_config') or {}).get('l4Distribution') or {}
    if not is_p6(policy.get('artifact')):return {}
    bundle=policy['artifact'];saved=state.get('p6_inference_universe') or {};day=state['run_date']
    validate_universe(saved,day,bundle)
    if identity!=bundle['l3_identity']:raise ValueError('p6_inference_frozen_l3_changed')
    from services.l4_native_observation import projection
    snapshot=projection(predictions,identity=identity,day=day,roster=saved['roster'],
        classification=saved['classification'],known_max=bundle['training_label_known_max'])
    snapshot.update(universe_checksum=saved['checksum'],classification_reference=saved['classification_reference'],
        native_predictions_checksum=digest(predictions))
    return dict(p6_native_pool=snapshot)
