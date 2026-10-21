"""P1 meta-label exclusion is applied to all three real producer selectors."""
from copy import deepcopy
from datetime import date, timedelta
import pytest
from services.alpha_model_roster import TIMEXER_MODELS
from services.l4_training_ancestry import HeldoutFold
from services.l4_native_meta_replica import replica_builder
from services.l4_distribution_dataset import build_native_oof_rows, NET_LABEL_SCHEMA


def fixture():
    first = date(2026, 1, 1)
    rows = []
    for d in range(44):
        day = str(first + timedelta(days=d))
        for i in range(60):
            for j, model in enumerate(TIMEXER_MODELS):
                rank = ((i + j) % 60) / 59
                rows.append(dict(fold_id='w0',prediction_date=day,symbol=f'S{i:03d}',
                    market_segment='LISTED',model_name=model,rank_score=rank,raw_score=rank,
                    target_return=(i/59-.5)*.08,label_known_date=str(first+timedelta(days=d+5)),
                    artifact_version=model+'-fixture',artifact_checksum='c'*64,
                    test_start=str(first),test_end='2026-02-13',train_end='2025-12-20',
                    cohort_id='fixture',target_semantic_version=NET_LABEL_SCHEMA))
    fold = HeldoutFold('2026-01-25','2026-01-27',frozenset(
        str(first+timedelta(days=d)) for d in range(19,32)))
    parent = dict(signal_policy={},cohort_id='fixture',base_artifact_set_checksum='b'*64,
                  observation_artifacts={name:{} for name in TIMEXER_MODELS},payload_checksum='p'*64)
    return rows, fold, parent


def test_forbidden_labels_cannot_change_later_stacker_or_isotonic_calibration():
    rows, fold, parent = fixture()
    changed = deepcopy(rows)
    for row in changed:
        if fold.excludes(row['prediction_date'],row['label_known_date']):
            row['target_return'] = 100 - row['target_return']
    cutoff = '2026-02-12'
    def fit(data, isolate):
        prior = [r for r in data if r['label_known_date']<=cutoff and
                 (not isolate or not fold.excludes(r['prediction_date'],r['label_known_date']))]
        build, evidence = replica_builder(data,parent,excluded_label_fold=fold if isolate else None)
        return build(prior,knowledge_cutoff_date=cutoff), evidence
    actual, evidence = fit(rows,True)
    again, second = fit(changed,True)
    assert again == actual
    assert second == evidence  # includes daily fitted coefficients and inner lambda
    assert fit(rows,False)[0] != fit(changed,False)[0]  # positive control: poison matters without purge
    build,_=replica_builder(rows,parent,excluded_label_fold=fold)
    with pytest.raises(ValueError,match='forbidden_label_ancestor'):
        build([r for r in rows if r['label_known_date']<=cutoff],knowledge_cutoff_date=cutoff)


def test_dataset_only_passes_permitted_prior_labels_without_dropping_scoring_dates():
    rows, fold, parent = fixture()
    seen = []
    def build(prior, *, knowledge_cutoff_date, **kwargs):
        assert all(not fold.excludes(r['prediction_date'],r['label_known_date']) for r in prior)
        assert all(r['label_known_date']<=knowledge_cutoff_date for r in prior)
        seen.append(knowledge_cutoff_date)
        raise ValueError('test_insufficient')
    _, receipt = build_native_oof_rows(rows, manifest=dict(schema_version='active8-oof-cohort-manifest-v5',
        target_semantic_version=NET_LABEL_SCHEMA,cohort_id='fixture',manifest_checksum='a'*64),
        parent_l3=parent,parent_identity={'payload_checksum':parent['payload_checksum']},as_of='2026-03-01',
        meta_builder=build,excluded_label_fold=fold)
    assert len(seen)==44
    assert len(receipt['excluded_warmup_folds'])==44
