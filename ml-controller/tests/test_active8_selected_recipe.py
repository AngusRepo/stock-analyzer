"""Synthetic-only recipe parity and causal-input contracts; no monthly runs."""
from copy import deepcopy
from datetime import date, timedelta

import numpy as np
import pytest

from services import active8_stacker_recipe as recipe_owner
from services import active8_oof_stacker as stack
from services.l4_distribution import digest
from services.l4_training_ancestry import HeldoutFold
from services.alpha_model_roster import TIMEXER_MODELS as ORDER
from test_l4_monthly_stacker_experiments import fixture as comparison_fixture
from test_p6_native_isolation import fixture as native_fixture


def sealed_recipe(mode='sum_loss', removed=None, order=ORDER):
    body = dict(schema_version=recipe_owner.RECIPE_SCHEMA, mode=mode,
        active_models=[m for m in order if m != removed],
        source_comparison_checksum='1'*64, selection_receipt_checksum='2'*64)
    return {**body, 'recipe_checksum':digest(body)}


def seal_context(payload):
    payload = deepcopy(payload)
    if payload.get('graph'):
        payload['graph']['checksum'] = digest({k:v for k,v in payload['graph'].items() if k != 'checksum'})
    payload['checksum'] = digest({k:v for k,v in payload.items() if k != 'checksum'})
    return payload


def qualification_context(rows, *, graph=False, order=ORDER):
    maturity = {}
    for row in rows:
        day = row['prediction_date']
        maturity[day] = max(maturity.get(day, ''), row['label_known_date'])
    days = sorted(maturity)
    qualification, nodes, roots = {}, {}, {}
    for model in order:
        metrics = []
        roots[model] = {}
        for i in range(0, len(days), 5):
            metric = dict(fold_id=f'q{i//5}', oos_ic=.1,
                date_cluster_ics=[dict(date=d,rank_ic=.1) for d in days[i:i+5]])
            metrics.append(metric)
            parents = []
            for d in days[i:i+5]:
                label = 'label:'+d
                nodes[label] = dict(kind='label',complete=True,parents=[],date=d,label_known_date=maturity[d])
                parents.append(label)
            root = model+':'+metric['fold_id']
            nodes[root] = dict(kind='derived',complete=True,parents=parents,
                qualification_metric_checksum=digest(metric))
            roots[model][metric['fold_id']] = root
        # Synthetic policy has enough early evidence to expose changes in the prior.
        qualification[model] = dict(fold_metrics=metrics,
            policy={'tail_fold_guard':{'tail_folds':1,'min_date_clusters':1}})
    body = dict(schema_version=recipe_owner.QUALIFICATION_SCHEMA,qualification=qualification,
        maturity=maturity,source_manifest_checksum='3'*64)
    if graph:
        body.update(metric_roots=roots,requested_cutoff=dict(signal_date_max=days[-1],label_known_at_max=max(maturity.values())),
            graph=dict(schema_version='l4-training-ancestry-v1',nodes=nodes,
                       producer_source_sha256='4'*64,source_receipts=['5'*64]))
    return seal_context(body)


def fit_arrays():
    rows, _ = comparison_fixture()
    rows = rows[:40*24]
    return tuple(np.asarray([r[k] for r in rows],dtype=float if k in ('stacker_features','target_return') else object)
                 for k in ('stacker_features','target_return','prediction_date','market_segment','label_known_date')), rows


@pytest.mark.parametrize('removed',recipe_owner.TREES)
def test_p7_uses_same_ablation_owner_and_keeps_sixteen_coordinates(removed):
    (x,y,dates,markets,known), _ = fit_arrays()
    expected = recipe_owner.ablated_fit(x,y,dates,markets,known=known,order=ORDER,removed=removed)
    actual = recipe_owner.fit_selected_recipe(x,y,dates,markets,label_known_dates=known,model_order=ORDER,
        recipe=sealed_recipe(removed=removed),cutoff_exclusive='2026-09-01')
    np.testing.assert_array_equal(actual[0],expected[0])
    assert actual[1:4] == expected[1:]
    assert actual[0].shape == (16,)
    assert actual[0][ORDER.index(removed)] == actual[0][ORDER.index(removed)+8] == 0


def test_explicit_control_and_mean_use_existing_fit_arithmetic():
    (x,y,dates,markets,known), rows = fit_arrays()
    control = recipe_owner.fit_selected_recipe(x,y,dates,markets,label_known_dates=known,model_order=ORDER,
        recipe=sealed_recipe(),cutoff_exclusive='2026-09-01')
    before = stack._fit_selected_ridge(x,y,dates,markets,label_known_dates=known,model_order=ORDER)
    np.testing.assert_array_equal(control[0],before[0]); assert control[1:4] == before[1:]
    context = qualification_context(rows)
    current = recipe_owner.fit_selected_recipe(x,y,dates,markets,label_known_dates=known,model_order=ORDER,
        recipe=sealed_recipe('mean_loss_causal_prior'),cutoff_exclusive='2026-09-01',qualification_context=context)
    proof = current[4]
    expected = stack.fit_qualified_prior_ridge(x,y,dates,markets,label_known_dates=known,model_order=ORDER,
        rank_prior=np.asarray(proof['prior']),inner_rank_prior=np.asarray(proof['inner_prior']))
    np.testing.assert_array_equal(current[0],expected[0]); assert current[1:3] == expected[1:]
    assert current[3] == ORDER


def test_p6_requires_graph_and_rejects_unbound_metric_support():
    (x,y,dates,markets,known), rows = fit_arrays()
    fold = HeldoutFold('2026-08-01','2026-08-02',frozenset())
    args = dict(label_known_dates=known,model_order=ORDER,recipe=sealed_recipe('mean_loss_causal_prior'),
                cutoff_exclusive='2026-09-01',excluded_label_fold=fold)
    with pytest.raises(ValueError,match='ancestry_required'):
        recipe_owner.fit_selected_recipe(x,y,dates,markets,qualification_context=qualification_context(rows),**args)
    context = qualification_context(rows,graph=True)
    root = context['metric_roots'][ORDER[0]]['q0']
    context['graph']['nodes'][root]['parents'] = []
    with pytest.raises(ValueError,match='metric_support_unbound'):
        recipe_owner.fit_selected_recipe(x,y,dates,markets,qualification_context=seal_context(context),**args)


def test_prior_drops_whole_metric_fold_for_direct_and_transitive_forbidden_labels():
    _, rows = fit_arrays()
    payload = qualification_context(rows,graph=True)
    fold = HeldoutFold('2026-06-13','2026-06-14',frozenset(['2026-06-18']))
    # q7's own outcomes do not touch the heldout; its upstream checkpoint does.
    root = payload['metric_roots'][ORDER[0]]['q7']
    payload['graph']['nodes'][root]['parents'].append('label:2026-06-13')
    context = recipe_owner.prepare_qualification_context(seal_context(payload),ORDER,excluded_label_fold=fold)
    prior, proof = recipe_owner.causal_prior(context.evidence,ORDER,context.maturity,'2026-09-01',
        excluded_label_fold=fold,qualification_ancestry=context)
    assert 'q1' not in proof[ORDER[0]]['folds']  # some outcomes overlap; entire fold excluded
    assert 'q2' not in proof[ORDER[0]]['folds']
    assert 'q3' not in proof[ORDER[0]]['folds']  # purge date excluded
    assert 'q7' not in proof[ORDER[0]]['folds']  # clean outcome, dirty checkpoint ancestor
    assert any('forbidden_label_ancestor' in r['reason'] for r in proof[ORDER[0]]['excluded_folds'])
    no_fold, control = recipe_owner.causal_prior(context.evidence,ORDER,context.maturity,'2026-09-01',
        qualification_ancestry=context)
    assert 'q7' in control[ORDER[0]]['folds']
    assert prior.sum() == pytest.approx(1) and no_fold.sum() == pytest.approx(1)


def test_default_builders_do_not_enter_selected_recipe_owner(monkeypatch):
    from test_active8_oof_stacker import _rows
    from test_active8_ensemble_artifact import _build, _rows as artifact_rows
    from services.l4_native_meta_replica import replica_builder
    monkeypatch.setattr(recipe_owner,'fit_selected_recipe',lambda *a,**k:pytest.fail('default changed owner'))
    _, evidence = stack.build_chronological_oof_stack(_rows())
    assert 'stacker_recipe' not in evidence
    rows, fold, parent = native_fixture()
    build, _ = replica_builder(rows,parent,excluded_label_fold=fold)
    prior = [r for r in rows if r['label_known_date']<='2026-02-12' and not fold.excludes(r['prediction_date'],r['label_known_date'])]
    assert 'stacker_recipe' not in build(prior,knowledge_cutoff_date='2026-02-12')
    assert 'stacker_recipe' not in _build(artifact_rows())


def test_p6_poison_cannot_change_allowed_fit_or_calibration_but_has_effect_without_exclusion():
    from services.l4_native_meta_replica import replica_builder
    rows, fold, parent = native_fixture()
    recipe = sealed_recipe('mean_loss_causal_prior')
    parent['stacker_recipe'] = recipe
    context = qualification_context(rows,graph=True)
    changed, poisoned = deepcopy(rows),deepcopy(context)
    for row in changed:
        if fold.excludes(row['prediction_date'],row['label_known_date']):
            row['target_return'] = 100-row['target_return']
    for model, evidence in poisoned['qualification'].items():
        for metric in evidence['fold_metrics']:
            if any(fold.excludes(c['date'],poisoned['maturity'][c['date']]) for c in metric['date_cluster_ics']):
                metric['oos_ic'] = -100
                for cluster in metric['date_cluster_ics']:
                    cluster['rank_ic'] = -100
                root = poisoned['metric_roots'][model][metric['fold_id']]
                poisoned['graph']['nodes'][root]['qualification_metric_checksum'] = digest(metric)
    poisoned = seal_context(poisoned)
    def fitted(data,qualification,isolate):
        prior = [r for r in data if r['label_known_date']<='2026-02-12'
                 and (not isolate or not fold.excludes(r['prediction_date'],r['label_known_date']))]
        build,evidence = replica_builder(data,parent,excluded_label_fold=fold if isolate else None,
            stacker_recipe=recipe,qualification_context=qualification)
        result = build(prior,knowledge_cutoff_date='2026-02-12')
        states = [{k:s[k] for k in ('prediction_date','weights','intercept','regularization')}
                  for f in evidence['folds'] for s in f['date_states']]
        return result['fit'],result['calibration'],states
    assert fitted(rows,context,True) == fitted(changed,poisoned,True)
    assert fitted(rows,context,False) != fitted(changed,poisoned,False)


def test_recipe_seals_and_parent_bindings_reject_untested_or_silent_changes():
    recipe = sealed_recipe()
    altered = deepcopy(recipe); altered['active_models'].pop()
    with pytest.raises(ValueError,match='unsealed'):
        recipe_owner.validate_recipe(altered,ORDER)
    for invalid in (sealed_recipe('mean_loss_causal_prior','LightGBM'),
                    sealed_recipe(removed='TimeXer')):
        with pytest.raises(ValueError,match='untested_combination'):
            recipe_owner.validate_recipe(invalid,ORDER)
    with pytest.raises(ValueError,match='required'):
        recipe_owner.validate_parent_recipe({'stacker_recipe':recipe},None,ORDER)
    with pytest.raises(ValueError,match='mismatch'):
        recipe_owner.validate_parent_recipe({'stacker_recipe':recipe},sealed_recipe(removed='LightGBM'),ORDER)


def test_final_fit_converts_inclusive_knowledge_boundary_without_dropping_same_day(monkeypatch):
    import services.active8_ensemble_artifact as artifact
    from test_active8_ensemble_artifact import _rows,_base_artifacts
    rows = _rows()
    cutoff = max(r['label_known_date'] for r in rows)
    recipe = sealed_recipe(order=stack.ACTIVE8_MODELS)
    calls = []
    actual = recipe_owner.fit_selected_recipe
    def capture(*args,**kw):
        calls.append((kw['cutoff_exclusive'],max(kw['label_known_dates'])))
        return actual(*args,**kw)
    monkeypatch.setattr(recipe_owner,'fit_selected_recipe',capture)
    result = artifact.build_active8_ensemble_artifact(rows,base_artifacts=_base_artifacts(),
        cohort_id='cohort-v1',source_manifest_checksum='a'*64,knowledge_cutoff_date=cutoff,stacker_recipe=recipe)
    assert calls[-1] == (str(date.fromisoformat(cutoff)+timedelta(days=1)),cutoff)
    assert result['fit']['recipe_fit_receipt']['label_known_max'] == cutoff
    assert result['stacker_recipe'] == recipe


@pytest.mark.parametrize('mode,removed',[('mean_loss_causal_prior',None),('sum_loss','ExtraTrees')])
def test_final_artifact_carries_same_recipe_through_oof_and_final(mode,removed):
    from services.active8_ensemble_artifact import build_active8_ensemble_artifact
    from test_active8_ensemble_artifact import _rows,_base_artifacts
    rows = _rows()
    recipe = sealed_recipe(mode,removed,stack.ACTIVE8_MODELS)
    context = qualification_context(rows,order=stack.ACTIVE8_MODELS)
    context['source_manifest_checksum'] = 'a'*64
    result = build_active8_ensemble_artifact(rows,base_artifacts=_base_artifacts(),cohort_id='cohort-v1',
        source_manifest_checksum='a'*64,knowledge_cutoff_date='2026-03-31',
        stacker_recipe=recipe,qualification_context=seal_context(context) if removed is None else None)
    assert result['stacker_recipe']['recipe_checksum'] == result['fit']['recipe_fit_receipt']['recipe_checksum']
    assert set(result['observation_artifacts']) == set(stack.ACTIVE8_MODELS)
    if removed:
        assert removed not in result['selected_models']
        i = stack.ACTIVE8_MODELS.index(removed)
        assert result['fit']['coefficients'][i] == result['fit']['coefficients'][i+8] == 0
    else:
        assert result['selected_models'] == list(stack.ACTIVE8_MODELS)


def test_dataset_requires_matching_prior_source_even_with_injected_test_builder():
    from services.l4_distribution_dataset import build_native_oof_rows,NET_LABEL_SCHEMA
    rows,fold,parent = native_fixture()
    recipe = sealed_recipe('mean_loss_causal_prior')
    parent['stacker_recipe'] = recipe
    args = dict(manifest=dict(schema_version='active8-oof-cohort-manifest-v5',target_semantic_version=NET_LABEL_SCHEMA,
                cohort_id='fixture',manifest_checksum='a'*64),parent_l3=parent,
                parent_identity={'payload_checksum':parent['payload_checksum']},as_of='2026-03-01',
                stacker_recipe=recipe,excluded_label_fold=fold,meta_builder=lambda *a,**kw:pytest.fail('invalid source reached fit'))
    context = qualification_context(rows,graph=True)
    with pytest.raises(ValueError,match='manifest_mismatch'):
        build_native_oof_rows(rows,qualification_context=context,**args)
    context['source_manifest_checksum'] = 'a'*64
    context.pop('graph')
    with pytest.raises(ValueError,match='ancestry_required'):
        build_native_oof_rows(rows,qualification_context=seal_context(context),**args)


def test_p7_native_dataset_keeps_excluded_trees_features_and_warmup_has_zero_weight():
    from services.l4_distribution_dataset import build_native_oof_rows,NET_LABEL_SCHEMA
    rows,fold,parent = native_fixture()
    recipe = sealed_recipe(removed='LightGBM')
    parent.update(stacker_recipe=recipe,signal_policy=dict(
        buy_coverage=.9,strong_coverage=.95,target_semantic_version=NET_LABEL_SCHEMA))
    _, evidence = stack.build_chronological_oof_stack(rows,stacker_recipe=recipe,excluded_label_fold=fold)
    for state in evidence['folds'][0]['date_states']:
        assert state['weights']['LightGBM.rank'] == state['weights']['LightGBM.available'] == 0
        assert 'LightGBM' not in state['selected_models']
    output, receipt = build_native_oof_rows(rows,manifest=dict(
        schema_version='active8-oof-cohort-manifest-v5',target_semantic_version=NET_LABEL_SCHEMA,
        cohort_id='fixture',manifest_checksum='a'*64),parent_l3=parent,
        parent_identity={'payload_checksum':parent['payload_checksum']},as_of='2026-03-01',
        stacker_recipe=recipe,excluded_label_fold=fold)
    assert output and receipt['stacker_recipe'] == recipe
    assert all(r['source']['stacker_recipe_checksum'] == recipe['recipe_checksum'] for r in output)
    assert all(len(r['features'])==30 and r['features']['LightGBM_available']==1
               and r['features']['LightGBM_raw'] is not None for r in output)
