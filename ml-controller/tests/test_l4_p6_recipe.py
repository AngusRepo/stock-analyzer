from copy import deepcopy
import numpy as np
import pytest
from services.l4_p6_recipe import matrix, targets, RECIPE, PROTOCOL
from services.l4_p6_pure_head import MODELS
from services.l4_training_ancestry import HeldoutFold, check_roots, verify_graph
from services.training_dual_cutoff import TrainingCutoff
from services.l4_distribution import digest


def rows(day='2026-09-21'):
    result=[]
    for i in range(7):
        f={f'{m}_{s}':(1 if s=='available' else i/6 if s=='rank' else i*.02) for m in MODELS for s in ['available','rank','raw']}
        f.update(ml_edge_norm=.3,ensemble_directional_margin=i*.01)
        result.append(dict(date=day,symbol=str(1000+i),gross_return=(i-2)*.1,features=f))
    return result


def test_actual_target_never_subtracts_A_and_validation_is_unclipped():
    source=rows()
    for r in source:r['A']=100-r['gross_return']*100
    train=targets(source,training=True);val=targets(source,training=False)
    expected=np.array([r['gross_return'] for r in source]);expected-=expected.mean()
    np.testing.assert_allclose(val['target'],expected)
    assert train['target'][0]>val['target'][0] and train['target'][-1]<val['target'][-1]
    assert PROTOCOL['selection_target']=='actual_pool_relative_return_daily_equal_rank_IC'


def test_validation_keeps_training_scalers_and_only_p_loss_head():
    train=rows();p=np.linspace(.2,.8,7)
    tx,recipe=matrix(train,p)
    val=rows('2026-09-22');vx,reused=matrix(val,p+.1,recipe)
    assert tx.shape==vx.shape==(7,31) and reused==recipe
    assert recipe['recipe_version']==RECIPE and recipe['feature_names'][-1]=='p_loss'
    assert not set(recipe['feature_names'])&{'gain','loss','A','expected_return_gross'}
    np.testing.assert_array_equal(tx[:,:30],vx[:,:30])
    np.testing.assert_allclose(vx[:,-1]-tx[:,-1],.1/recipe['p_loss_scaler']['scale'],rtol=1e-6)


def test_reject_legacy_DLinear_coordinate_even_if_width_30():
    source=rows()
    for r in source:r['features']={k.replace('TimeXer','DLinear'):v for k,v in r['features'].items()}
    with pytest.raises(ValueError,match='feature_contract'):matrix(source,[.5]*7)


@pytest.mark.parametrize('probabilities',[[.5]*6,[1.1]*7,[float('nan')]*7])
def test_invalid_p_loss_cannot_enter_training(probabilities):
    with pytest.raises(ValueError,match='probability_invalid'):matrix(rows(),probabilities)


def graph():
    nodes={'known':dict(kind='label',complete=True,parents=[],date='2026-08-03',label_known_date='2026-08-10'),
        'base':dict(kind='derived',complete=True,parents=['known']),
        'meta':dict(kind='derived',complete=True,parents=['base']),
        'head':dict(kind='derived',complete=True,parents=['meta'])}
    body=dict(schema_version='l4-training-ancestry-v1',nodes=nodes,producer_source_sha256='1'*64,source_receipts=['2'*64])
    return {**body,'checksum':digest(body)}


def test_clean_head_does_not_hide_contaminated_base_ancestor():
    g=graph();nodes=verify_graph(g)
    cutoff=TrainingCutoff('2026-09-22','2026-10-01')
    fold=HeldoutFold('2026-09-02','2026-09-15',frozenset(['2026-08-26']))
    assert check_roots(nodes,['head'],cutoff=cutoff,signal_date='2026-09-21',fold=fold)['forbidden_label_ancestors']==0
    nodes['known'].update(date='2026-09-03',label_known_date='2026-09-10')
    with pytest.raises(ValueError,match='forbidden_label_ancestor:known'):
        check_roots(nodes,['head'],cutoff=cutoff,signal_date='2026-09-21',fold=fold)


@pytest.mark.parametrize('date,known', [('2026-08-26','2026-08-31'),('2026-08-31','2026-09-07'),('2026-09-21','2026-10-01')])
def test_purge_interval_and_available_at_checks(date,known):
    nodes=verify_graph(graph());nodes['known'].update(date=date,label_known_date=known)
    with pytest.raises(ValueError,match='forbidden_label_ancestor'):
        check_roots(nodes,['head'],cutoff=TrainingCutoff('2026-09-22','2026-10-01'),
            signal_date='2026-09-21',fold=HeldoutFold('2026-09-02','2026-09-15',frozenset(['2026-08-26'])))


def test_incomplete_or_modified_graph_is_refused():
    g=graph();g['nodes']['base']['parents']=[]
    with pytest.raises(ValueError,match='unverified'):verify_graph(g)
    nodes=verify_graph(graph());nodes['base']['complete']=False
    with pytest.raises(ValueError,match='incomplete'):
        check_roots(nodes,['head'],cutoff=TrainingCutoff('2026-09-22','2026-10-01'),signal_date='2026-09-21')


def test_fold_preparation_seals_native_inputs_and_rejects_overwrite(tmp_path):
    from datetime import date,timedelta
    import hashlib,json
    import polars as pl
    from services.l4_p6_recipe import prepare_fold
    calendar=[(date(2026,7,1)+timedelta(days=i)).isoformat() for i in range(100)
        if (date(2026,7,1)+timedelta(days=i)).weekday()<5]
    source=[]
    for i,day in enumerate(calendar[10:50],10):
        for row in rows(day):
            row.update(label_known_date=calendar[i+5],feature_roots={**{m:'base' for m in MODELS},'native_meta':'meta'})
            source.append(row)
    g=graph();g['nodes']['known'].update(date='2026-06-01',label_known_date='2026-06-08')
    g['checksum']=digest({k:v for k,v in g.items() if k!='checksum'})
    spec=dict(fold=1,head_eligible_train_dates=[calendar[35]],head_eligible_validation_dates=[calendar[49]],
        calendar_purge_dates=calendar[44:55])
    cutoff=TrainingCutoff('2026-09-22','2026-10-01')
    result=prepare_fold(source,spec=spec,graph=g,cutoff=cutoff,calendar=calendar,calendar_sha256='a'*64,output=tmp_path)
    assert result['affected_train_rows']==result['affected_validation_rows']==0
    assert result['checksum']==digest({k:v for k,v in result.items() if k!='checksum'})
    assert pl.read_parquet(tmp_path/'native-rows.parquet').height==len(source)
    for name,expected in result['files_sha256'].items():
        assert hashlib.sha256((tmp_path/name).read_bytes()).hexdigest()==expected
    assert prepare_fold(source,spec=spec,graph=g,cutoff=cutoff,calendar=calendar,calendar_sha256='a'*64,output=tmp_path)==result
    (tmp_path/'val-rows.parquet').write_bytes(b'changed')
    with pytest.raises(ValueError,match='immutable_output_conflict:val-rows'):
        prepare_fold(source,spec=spec,graph=g,cutoff=cutoff,calendar=calendar,calendar_sha256='a'*64,output=tmp_path)


def test_shared_ancestry_reused_but_one_foreign_root_still_rejected(tmp_path,monkeypatch):
    from datetime import date,timedelta
    from services import l4_p6_recipe as owner
    calendar=[(date(2026,7,1)+timedelta(days=i)).isoformat() for i in range(100)
        if (date(2026,7,1)+timedelta(days=i)).weekday()<5]
    source=[]
    for i,day in enumerate(calendar[10:50],10):
        for row in rows(day):
            row.update(label_known_date=calendar[i+5],feature_roots={**{m:'base' for m in MODELS},'native_meta':'meta'})
            source.append(row)
    g=graph();g['nodes']['known'].update(date='2026-06-01',label_known_date='2026-06-08')
    g['checksum']=digest({k:v for k,v in g.items() if k!='checksum'})
    spec=dict(fold=1,head_eligible_train_dates=[calendar[35]],head_eligible_validation_dates=[calendar[49]],
        calendar_purge_dates=calendar[44:55])
    kwargs=dict(spec=spec,graph=g,cutoff=TrainingCutoff('2026-09-22','2026-10-01'),
        calendar=calendar,calendar_sha256='a'*64)
    actual=owner.check_roots;calls=[]
    def checked(*args,**kw):
        calls.append((kw['signal_date'],tuple(args[1])))
        return actual(*args,**kw)
    monkeypatch.setattr(owner,'check_roots',checked)
    owner.prepare_fold(source,output=tmp_path/'clean',**kwargs)
    assert len(calls)==40  # 280 rows, forty distinct date/root closures.
    calls.clear()
    dirty=deepcopy(source)
    dirty[-1]['feature_roots']['TimeXer']='forbidden'
    g['nodes']['forbidden']=dict(kind='label',complete=True,parents=[],date=calendar[49],label_known_date=calendar[54])
    g['checksum']=digest({k:v for k,v in g.items() if k!='checksum'})
    with pytest.raises(ValueError,match='forbidden_label_ancestor:forbidden'):
        owner.prepare_fold(dirty,output=tmp_path/'dirty',**kwargs)
    assert len(calls)==41 and not (tmp_path/'dirty').exists()
