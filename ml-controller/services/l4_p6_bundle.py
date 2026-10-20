"""Explicit P6-a serving bundle, separate from the legacy three-head recipe.

Construction validates final checkpoints and frozen OOF calibration. It neither
publishes a pointer nor grants a Paper release without engineering acceptance.
"""
from copy import deepcopy
from datetime import date, datetime
import hashlib
import math
import re
import numpy as np
from services.l4_distribution import digest, SCHEMA, LABEL_SCHEMA, TIMEXER_FEATURE_SCHEMA
from services.l4_p6_recipe import RECIPE, PROTOCOL, matrix
from services import l4_p6_pure_head as pure
from services.l4_p6_inference import infer_seed

MODEL_SCHEMA = 'l4-p6-direct-excess-model-v1'
WEIGHTS_PREFIX = 'l4_distribution/p6_batches/'

def _hash(value):
    return isinstance(value,str) and re.fullmatch('[a-f0-9]{64}',value) is not None

def is_p6(bundle):
    return ((bundle or {}).get('model') or {}).get('schema_version') == MODEL_SCHEMA

def verify_inner_report(report):
    if (report.get('schema_version')!='p6-inner-validation-r32-v1'
            or report.get('checksum')!=digest({k:v for k,v in report.items() if k!='checksum'})
            or report.get('evidence_scope')!='inner_development_only' or report.get('outer_credit')!=0):
        raise ValueError('p6_bundle_inner_report_identity')
    calibration=report['calibration']
    if calibration.get('checksum')!=digest({k:v for k,v in calibration.items() if k!='checksum'}):
        raise ValueError('p6_bundle_calibration_checksum')
    top5=report['metrics']['all']['top5_excess_pp'].get('mean')
    high={r['bin']:r['mean'] for r in calibration['realized_bins'] if r['bin']>=6}
    if (not isinstance(top5,(int,float)) or not math.isfinite(top5) or top5<=0
            or set(high)!={6,7,8} or any(v is None or not math.isfinite(v) or v<=0 for v in high.values())):
        raise ValueError('p6_bundle_R32_B_gate_failed')
    if report.get('champion_B_gate',{}).get('status')!='pass':
        raise ValueError('p6_bundle_R32_gate_receipt_inconsistent')

def validate(bundle,*,l3_identity,signal_date,load_bytes=None):
    model=bundle.get('model') or {}
    if (not is_p6(bundle) or bundle.get('schema_version')!=SCHEMA
            or bundle.get('feature_schema')!=TIMEXER_FEATURE_SCHEMA or bundle.get('label_schema')!=LABEL_SCHEMA
            or bundle.get('horizon_sessions')!=5 or model.get('recipe_version')!=RECIPE
            or model.get('calibration_kind') not in ('raw','linear')
            or set(model)&{'heads','residual_tabpack','residual_mlp','A','gain','loss'}
            or model.get('expected_return_semantic')!='five_session_relative_pool_decimal'):
        raise ValueError('p6_bundle_contract')
    if not l3_identity or bundle.get('l3_identity')!=l3_identity:
        raise ValueError('p6_bundle_l3_identity')
    if bundle.get('model_checksum')!=digest(model):raise ValueError('p6_bundle_model_checksum')
    day=date.fromisoformat(signal_date)
    final=model['final_input_receipt']
    if (final.get('checksum')!=digest({k:v for k,v in final.items() if k!='checksum'})
            or final.get('schema_version')!='p6-final-refit-inputs-v1' or final.get('recipe')!=RECIPE
            or final.get('epoch_reselection_allowed') is not False or final.get('outer_rows')!=0):
        raise ValueError('p6_bundle_final_input_receipt')
    bounds=final['requested_cutoff']
    known=final['label_known_at_max'];signal=final['signal_date_max']
    if not signal<known or signal>bounds['signal_date_max'] or known>bounds['label_known_at_max']:
        raise ValueError('p6_bundle_training_cutoff')
    if date.fromisoformat(bundle['training_label_known_max'])>=day or bundle['training_label_known_max']<known:
        raise ValueError('p6_bundle_training_after_signal')
    report=model['inner_report'];verify_inner_report(report)
    calibration=model['calibration']
    if (calibration!=report['calibration'] or calibration.get('schema_version')!='p6-frozen-oof-calibration-v1'
            or calibration.get('requested_cutoff')!=bounds or calibration.get('scope')!='full_classified_candidate_pool'
            or any(calibration.get(k) is not False for k in ('outer_updates_allowed','outer_data_used','refit_predictions_used'))
            or not math.isfinite(calibration['linear_b']) or calibration['label_known_at_max']>bundle['training_label_known_max']):
        raise ValueError('p6_bundle_frozen_calibration')
    frozen=model['frozen_p_loss']
    if (frozen.get('checksum')!=digest({k:v for k,v in frozen.items() if k!='checksum'})
            or frozen.get('training_head_replaced') is not False or frozen.get('outer_updates_allowed') is not False
            or frozen['binding']['batch_id']!=final['batch_id'] or frozen['binding']['cutoff']!=bounds
            or frozen['receipt']['label_known_at_max']>bundle['training_label_known_max']
            or model['frozen_p_loss_sha256']!=final['files_sha256']['frozen-p-loss.json']):
        raise ValueError('p6_bundle_pure_head_binding')
    head=frozen['model'];pure.design(np.zeros((1,16)),[signal_date],head['recipe'])
    if (head['head'].get('head')!='p_loss' or np.asarray(head['head']['beta']).shape!=(16,)
            or not np.isfinite([head['head']['intercept'],*head['head']['beta']]).all()):
        raise ValueError('p6_bundle_pure_head_coefficients')
    seeds=model['seeds']
    if [s.get('seed') for s in seeds]!=[42,43,44]:raise ValueError('p6_bundle_seed_roster')
    for seed in seeds:
        lineage=seed['training_lineage'];ref=seed['weights']
        if (seed.get('phase')!='final' or seed.get('training_completed') is not True or seed.get('outer_rows')!=0
                or seed.get('recipe')!=RECIPE or seed.get('promoted') is not False
                or lineage['input_receipt_checksum']!=final['checksum']
                or lineage['fold_receipt_checksums']!=final['fold_receipt_checksums']
                or lineage['requested_cutoff']!=bounds or lineage['label_known_at_max']!=known
                or lineage['signal_date_max']!=signal or lineage['frozen_p_loss_sha256']!=model['frozen_p_loss_sha256']
                or lineage['selection_checksum']!=model['selection_checksums'][str(seed['seed'])]
                or not seed.get('checkpoint_restoration') or any(r.get('training_steps')!=0 for r in seed['checkpoint_restoration'])):
            raise ValueError('p6_bundle_seed_lineage')
        start=datetime.fromisoformat(seed['training_started_at'].replace('Z','+00:00'))
        end=datetime.fromisoformat(seed['training_completed_at'].replace('Z','+00:00'))
        if start.tzinfo is None or end.tzinfo is None or end<start or start.date().isoformat()<known:
            raise ValueError('p6_bundle_actual_training_time')
        expected=f"{WEIGHTS_PREFIX}{seed['sealed_batch_id']}/final/seed{seed['seed']}/weights.npz"
        if (not _hash(seed['sealed_batch_id']) or ref.get('path')!=expected or not _hash(ref.get('sha256'))
                or type(ref.get('bytes')) is not int or not 0<ref['bytes']<=96*1024**2
                or not str(ref.get('generation','')).isdigit()):
            raise ValueError('p6_bundle_weight_reference')
        recipe=seed['final_recipe']
        if (recipe.get('recipe_version')!=RECIPE or recipe.get('gain_loss_A_removed') is not True
                or recipe.get('A_weight')!=0 or recipe.get('p_loss_features')!=pure.NAMES):
            raise ValueError('p6_bundle_final_recipe')
        from services.alpha_model_roster import TIMEXER_MODELS
        sample={f'{name}_{field}':(1 if field=='available' else .5) for name in TIMEXER_MODELS for field in ('raw','rank','available')}
        sample.update(ml_edge_norm=0.,ensemble_directional_margin=0.)
        matrix([{'features':sample}],np.asarray([.5]),recipe)
        # Full weight shape/member validation occurs before release construction
        # and on every cold inference load; metadata checks never claim it ran.
        if load_bytes is not None:
            infer_seed(np.zeros((1,31),dtype=np.float32),seed,load_bytes(ref))

def assemble(*,results,final_receipt,frozen_p_loss,frozen_p_loss_raw,inner_report,
             selections,l3_identity,l3_training_label_known_max,calibration_kind,signal_date,load_bytes):
    final=deepcopy(final_receipt)
    if hashlib.sha256(frozen_p_loss_raw).hexdigest()!=final['files_sha256']['frozen-p-loss.json']:
        raise ValueError('p6_bundle_pure_head_file_sha')
    import json
    if json.loads(frozen_p_loss_raw)!=frozen_p_loss:raise ValueError('p6_bundle_pure_head_file_content')
    selection_hashes={}
    for seed in PROTOCOL['seeds']:
        selected=selections[seed]
        if (selected.get('checksum')!=digest({k:v for k,v in selected.items() if k!='checksum'})
                or selected.get('seed')!=seed or selected.get('recipe')!=RECIPE
                or selected.get('fold_receipt_checksums')!=final['fold_receipt_checksums']
                or selected.get('batch_id')!=final['batch_id'] or selected.get('selection_target')!=PROTOCOL['selection_target']):
            raise ValueError('p6_bundle_selection_identity')
        selection_hashes[str(seed)]=selected['checksum']
        from collections import Counter
        counts=Counter(tuple(k) for k in selected['selected'])
        result=next(r for r in results if r['seed']==seed)
        actual={(m['epoch'],m['member_id']):m['weight'] for m in result['members']}
        if (len(actual)!=len(result['members']) or actual!={k:v/len(selected['selected']) for k,v in counts.items()}
                or result['completed_epochs']!=selected['refit_max_epoch']):
            raise ValueError('p6_bundle_final_members_differ_from_frozen_selection')
    model=dict(schema_version=MODEL_SCHEMA,recipe_version=RECIPE,seeds=deepcopy(results),
        final_input_receipt=final,frozen_p_loss=deepcopy(frozen_p_loss),
        frozen_p_loss_sha256=hashlib.sha256(frozen_p_loss_raw).hexdigest(),
        inner_report=deepcopy(inner_report),calibration=deepcopy(inner_report['calibration']),
        calibration_kind=calibration_kind,selection_checksums=selection_hashes,
        expected_return_semantic='five_session_relative_pool_decimal')
    known=max(l3_training_label_known_max,final['label_known_at_max'],inner_report['calibration']['label_known_at_max'],frozen_p_loss['receipt']['label_known_at_max'])
    bundle=dict(schema_version=SCHEMA,feature_schema=TIMEXER_FEATURE_SCHEMA,label_schema=LABEL_SCHEMA,horizon_sessions=5,
        l3_identity=deepcopy(l3_identity),training_label_known_max=known,model=model,model_checksum=digest(model))
    validate(bundle,l3_identity=l3_identity,signal_date=signal_date,load_bytes=load_bytes)
    return bundle
