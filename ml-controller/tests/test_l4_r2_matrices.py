import copy
from datetime import date, timedelta
import json

import numpy as np
import polars as pl
import pytest
from services import l4_distribution as native
from services import l4_r2_matrices as subject
from test_l4_distribution import features, constant_model


def fixture():
    calendar = [(date(2026, 1, 1) + timedelta(days=i)).isoformat() for i in range(90)]
    rows = [dict(date=day, symbol=symbol, label_known_date=calendar[i + 5],
        l3_training_label_known_max='2025-12-01', l3_identity={'id': 'A'},
        features=features(.2 if symbol == 'A' else .8), feature_schema=native.FEATURE_SCHEMA,
        prediction_kind='oof', gross_return=(.02 if symbol == 'A' else -.01) + i * .0001,
        l3_baseline={'expected_return_gross': .01})
        for i, day in enumerate(calendar[:60]) for symbol in ('A', 'B')]
    receipt = dict(schema_version='l4-r2-training-source-v1', rows=len(rows),
        rows_checksum=native.digest(rows), cutoff=calendar[75] + 'T08:00:00+08:00',
        l3_identity={'id': 'A'}, feature_schema=native.FEATURE_SCHEMA,
        source_pool='native_non_etf_equity_v1', source_dates=calendar[:60],
        forward_receipts=[], prediction_kind_counts={'oof': len(rows), 'forward': 0},
        classification={'evidence_sha256': 'a' * 64})
    return rows, receipt, calendar


def test_actual_build_preserves_purge_and_train_only_scalers(tmp_path, monkeypatch):
    rows, receipt, calendar = fixture()
    calls = []
    def fit(part, **kwargs):
        assert all(r['label_known_date'] < kwargs['as_of'] for r in part)
        assert kwargs['forward_receipts'] == []
        calls.append(kwargs['as_of'])
        model = constant_model()
        return dict(model=model, model_checksum=native.digest(model),
                    training_rows_checksum=native.digest(part))
    monkeypatch.setattr(native, 'fit_candidate', fit)
    out = tmp_path / 'matrices'
    result = subject.build(rows, receipt, calendar=calendar, calendar_sha256='b' * 64, output=out)
    readiness = json.loads((out / 'data-readiness.json').read_bytes())
    assert len(result['eligible_dates']) == 40
    assert result['tabpack_training_started'] is False
    assert subject.sha(out / 'calendar.json') == result['calendar_file_sha256']
    assert calls[-1] == calendar[75]
    for fold in readiness['folds']:
        dest = out / str(fold['fold'])
        forbidden = set(fold['calendar_purge_dates'])
        lineage = json.loads((dest / 'head-lineage.json').read_bytes())
        assert not set(fold['head_eligible_train_dates']) & forbidden
        for head in lineage:
            assert not set(head['ancestor_dates']) & forbidden
            assert head['ancestor_label_known_max'] < head['date']
        train = [r for r in rows if r['date'] in fold['head_eligible_train_dates']]
        _, expected_recipe = subject.matrix(train, native.predict(train, constant_model()))
        assert json.loads((dest / 'recipe.json').read_bytes()) == expected_recipe
        with np.load(dest / 'arrays.npz') as arrays:
            assert arrays['train_x'].shape == (len(train), 34)
    with pytest.raises(FileExistsError):
        subject.build(rows, receipt, calendar=calendar, calendar_sha256='b' * 64, output=out)


def test_rejects_tamper_and_unreceipted_forward():
    rows, receipt, _ = fixture()
    changed = copy.deepcopy(rows)
    changed[0]['gross_return'] = 100
    with pytest.raises(ValueError, match='source_invalid'):
        subject.admit(changed, receipt)
    changed = copy.deepcopy(rows)
    changed[0].update(prediction_kind='forward', source={'snapshot_id': 'unverified'})
    receipt['rows_checksum'] = native.digest(changed)
    with pytest.raises(ValueError, match='training_receipt_invalid'):
        subject.admit(changed, receipt)
    changed = copy.deepcopy(rows)
    changed[0]['l3_training_label_known_max'] = changed[0]['date']
    receipt['rows_checksum'] = native.digest(changed)
    with pytest.raises(ValueError, match='source_rows_invalid'):
        subject.admit(changed, receipt)


def test_validation_tail_is_not_clipped_or_used_to_fit_normalizer():
    frame = pl.DataFrame(dict(date=['2026-01-01'] * 100, symbol=[str(i) for i in range(100)],
                             gross_return=[0.] * 99 + [100.], A=[0.] * 100))
    assert subject.targets(frame, training=False)['target'][-1] == 99.
    assert subject.targets(frame, training=True)['target'][-1] < 99.
    rows, _, calendar = fixture()
    with pytest.raises(ValueError, match='calendar_missing_source_or_label'):
        subject.qualify(rows, calendar[:64])
