"""Native-semantic, purged L3 meta replicas for offline L4 training.

Never invokes base-model training or mutates L3 serving. Each meta replica sees
only labels known before its prediction fold. Rank != calibrated probability.
"""
from collections import defaultdict,Counter
from datetime import date, timedelta
from services.l4_distribution import FEATURE_SCHEMA, MODELS, digest, finite

NET_LABEL_SCHEMA = 'next-session-canonical-adjusted-open-to-fifth-session-canonical-adjusted-close-net-v4'


SEQUENCE_RAW_SCORE_SEMANTIC = 'forecast-t5-over-signal-close-gross-v1'


def validate_sequence_oof_lineage(predictions):
    """L4 refresh must not reuse future-open scores or outer-test-selected weights.

    Generic historical readers remain available for audits. Only immutable
    artifact metadata, verified by the OOF loader, can attest the new recipe.
    """
    counts = Counter()
    for row in predictions:
        name = row['model_name']
        if name not in MODELS[5:]:
            continue
        if row.get('raw_score_semantic_version') != SEQUENCE_RAW_SCORE_SEMANTIC:
            raise ValueError('l4_sequence_oof_score_semantic_unverified:' + name)
        if (name == 'DLinear' and row.get('checkpoint_selection')
                != 'fixed_final_epoch_outer_test_monitor_only'):
            raise ValueError('l4_sequence_oof_checkpoint_unverified:DLinear')
        counts[name] += 1
    if any(not counts[name] for name in MODELS[5:]):
        raise ValueError('l4_sequence_oof_model_evidence_missing')
    return {'raw_score_semantic_version': SEQUENCE_RAW_SCORE_SEMANTIC,
            'dlinear_checkpoint_selection': 'fixed_final_epoch_outer_test_monitor_only',
            'model_rows': dict(counts), 'source': 'checksum_verified_oof_artifact_metadata'}


def build_native_oof_rows(predictions, *, manifest, parent_l3, parent_identity, as_of, meta_builder=None):
    from services.ensemble_v2 import _evaluate_validated_ensemble
    from services.recommendation_service import calculate_ml_score, _rescale_score
    from services.l4_distribution_runtime import native_features
    from services.l4_l3_baseline import native_baseline
    if (manifest.get('schema_version') != 'active8-oof-cohort-manifest-v5'
            or manifest.get('target_semantic_version') != NET_LABEL_SCHEMA
            or parent_l3.get('payload_checksum') != parent_identity.get('payload_checksum')
            or parent_l3.get('cohort_id') != manifest.get('cohort_id')
            or len(manifest.get('manifest_checksum','')) != 64):
        raise ValueError('l4_dataset_verified_native_manifest_required')
    groups, folds = defaultdict(dict), {}
    for row in predictions:
        if row.get('cohort_id')!=manifest['cohort_id'] or row.get('target_semantic_version')!=NET_LABEL_SCHEMA:
            raise ValueError('l4_dataset_source_lineage_mismatch')
        day = row['prediction_date']
        for d in (day,row['train_end'],row['test_start'],row['label_known_date']):
            date.fromisoformat(d)
        if not row['train_end'] < row['test_start'] <= day < row['label_known_date']:
            raise ValueError('l4_dataset_base_training_overlaps_prediction')
        if row['label_known_date'] >= as_of:
            continue
        key=(row['fold_id'],day,row['symbol'])
        model=row['model_name']
        if model not in MODELS or model in groups[key]:
            raise ValueError('l4_dataset_model_duplicate_or_unknown')
        groups[key][model]=row
        if row['fold_id'] in folds and folds[row['fold_id']]!=row['test_start']:
            raise ValueError('l4_dataset_fold_boundary_disagreement')
        folds[row['fold_id']]=row['test_start']
    from services.l4_native_meta_replica import replica_builder
    if meta_builder is None:
        build_meta,meta_evidence=replica_builder(predictions,parent_l3)
    else:
        build_meta,meta_evidence=meta_builder,{'scope':'injected_test_builder'}
    output, replicas, excluded, rejected = [], {}, [], Counter()
    by_day=defaultdict(list)
    for key,models in groups.items():by_day[key[1]].append((key,models))
    for start in sorted(by_day):
        fold=next(iter(by_day[start]))[0][0]
        prior=[r for r in predictions if r['label_known_date']<start]
        cutoff=str(date.fromisoformat(start)-timedelta(days=1))
        try:
            replica=build_meta(prior,base_artifacts=parent_l3['observation_artifacts'],
                cohort_id=manifest['cohort_id'],source_manifest_checksum=manifest['manifest_checksum'],
                knowledge_cutoff_date=cutoff)
        except ValueError as exc:
            if 'insufficient' not in str(exc):
                raise
            excluded.append({'fold':fold,'date':start,'reason':str(exc),'scope':'training_warmup_only'})
            continue
        # The parent observation identities bind the intended release; these
        # replica coefficients are research only, and actual fold bases are below.
        replicas[start]={'checksum':replica['payload_checksum'],'label_known_max':max(r['label_known_date'] for r in prior),
                        'prediction_base_owner':'verified_oof_fold_artifacts','serving_mutation':False}
        selected=replica['selected_models']
        # Preserve the source L3 OOF eligibility boundary. Sequence-only raw
        # rows were never eligible native L3 recommendations, not L4 rejects.
        eligible=[]
        for key,models in sorted(by_day[start]):
            if any(name not in models for name in MODELS[:5]):
                rejected['source_l3_core_coverage_missing']+=1
                continue
            eligible.append((key,models))
        from services.active8_score_semantics import _percentile_by_average_rank
        ranks={}
        segments={next(iter(models.values()))['market_segment'] for _,models in eligible}
        for name in MODELS:
            for segment in segments:
                values=[(key[2],finite(models[name]['raw_score'],'raw_score')) for key,models in eligible
                    if name in models and models[name]['market_segment']==segment]
                ranks[(segment,name)]=_percentile_by_average_rank(values) if len(values)>=3 else {}
        for (row_fold,day,symbol), all_models in eligible:
            models={name:r for name,r in all_models.items() if name in selected
                and symbol in ranks[(r['market_segment'],name)]}
            if any(name not in models for name in selected if name in MODELS[:5]):
                rejected['source_l3_selected_core_rank_missing']+=1
                continue
            if not models:
                rejected['source_l3_no_selected_model']+=1
                continue
            known={r['label_known_date'] for r in models.values()}
            targets=[finite(r['target_return'],'net_label') for r in models.values()]
            if len(known)!=1 or max(targets)-min(targets)>1e-6:
                raise ValueError('l4_dataset_target_disagreement')
            prediction={'rank_scores':{name:ranks[(r['market_segment'],name)][symbol] for name,r in models.items()},
                'model_score_lineage':{'coverage_policy':'validated-bundle-selected-core-sequence-missingness-v1',
                                     'selected_models':selected,'ensemble_payload_checksum':replica['payload_checksum'],
                                     'complete':True,'optional_missing_models':[n for n in MODELS[5:] if n not in models],'raw_scores':{name:r['raw_score'] for name,r in models.items()},
                                     'artifact_versions':{name:r['artifact_version'] for name,r in models.items()}},
                'l3_model_eligibility':{'sequence_models':{name:{'eligible':False,
                    'reason':'active8_sequence_history_contract_unmet_optional_masked'} for name in MODELS if name not in models}}}
            prediction['ensemble_v2']=_evaluate_validated_ensemble(prediction,replica,{'complete':True})
            edge=_rescale_score(calculate_ml_score(prediction['ensemble_v2'],prediction),30,25)
            # Ensemble weighting is not an information filter for downstream L4.
            # Keep its native forecast unchanged while exposing every available
            # base model score and same-market rank to the L4 learner.
            full_models={name:r for name,r in all_models.items()
                if symbol in ranks[(r['market_segment'],name)]}
            l4_prediction={**prediction,
                'rank_scores':{name:ranks[(r['market_segment'],name)][symbol] for name,r in full_models.items()},
                'model_score_lineage':{**prediction['model_score_lineage'],
                    'raw_scores':{name:r['raw_score'] for name,r in full_models.items()},
                    'artifact_versions':{name:r['artifact_version'] for name,r in full_models.items()}}}
            feature=native_features({'score_components':{'components':{'mlEdge':edge}}},l4_prediction)
            output.append({'date':day,'symbol':symbol,'features':feature,'feature_schema':FEATURE_SCHEMA,
                'prediction_kind':'oof','l3_identity':parent_identity,
                'l3_baseline':native_baseline(prediction),
                'l3_training_label_known_max':max(replicas[start]['label_known_max'],max(r['train_end'] for r in full_models.values())),
                'label_known_date':next(iter(known)),
                # This exact version's canonical target subtracts 18 bps once.
                'gross_return':sum(targets)/len(targets)+.0018,
                'market_segment':next(iter(models.values()))['market_segment'],
                'source':{'manifest_checksum':manifest['manifest_checksum'],'fold_id':fold,
                          'meta_replica_checksum':replica['payload_checksum'],
                          'base_artifacts':{name:{'version':r['artifact_version'],'checksum':r['artifact_checksum']} for name,r in full_models.items()}}})
    receipt={'schema_version':'l4-native-oof-dataset-v1','feature_schema':FEATURE_SCHEMA,
        'parent_l3_identity':parent_identity,'source_manifest_checksum':manifest['manifest_checksum'],
        'source_label_semantic':NET_LABEL_SCHEMA,'gross_conversion_cost':.0018,
        'replicas':replicas,'excluded_warmup_folds':excluded,'rows':len(output),'rows_checksum':digest(output),
        'base_models_retrained':False,'source_pointer':manifest.get('manifest_path'),
        'meta_recipe':'native_chronological_ridge_and_prior_oof_isotonic',
        'meta_serving_eligibility':False,'source_l3_ineligible_rows':dict(rejected),
        'native_stacker_evidence':meta_evidence}
    return output,receipt
