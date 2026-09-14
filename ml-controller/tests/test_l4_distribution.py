import copy
from datetime import date, timedelta
import numpy as np
import pytest
from services import l4_distribution as model
from services.l4_portfolio import allocate


def features(value=.5):
    result = {f'{name}_{suffix}': (1 if suffix == 'available' else value)
              for name in model.MODELS for suffix in ('raw','rank','available')}
    return dict(result, ml_edge_norm=value, ensemble_directional_margin=value-.5)


def constant_model():
    return {'recipe': {'names': model.FEATURE_NAMES, 'mean': [0.]*30, 'scale': [1.]*30},
            'heads': {name: {'head': name, 'beta': [0.]*30, 'intercept': intercept}
                      for name, intercept in [('p_loss',0.),('gain',.02),('loss',.04)]}}


def test_signed_ev_and_outcomes_never_read():
    rows = [{'features':features(), 'target':99}]
    predicted = model.predict(rows, constant_model())
    assert predicted[0]['expected_return_gross'] == pytest.approx(-.01)
    rows[0]['target'] = -999
    assert model.predict(rows, constant_model()) == predicted
    assert predicted[0]['l4plus_status'] == 'disabled'


def test_missing_mask_and_feature_semantics():
    row = features()
    row['DLinear_available'] = 0
    with pytest.raises(ValueError, match='masked_forecast'):
        model.features(row)
    row['DLinear_raw'] = row['DLinear_rank'] = None
    assert model.features(row)['l3_available_fraction'] == 7/8
    row['TabM_rank'] = 2
    with pytest.raises(ValueError, match='rank_range'):
        model.features(row)


def test_bundle_identity_time_checksum_and_release():
    bundle = dict(schema_version=model.SCHEMA, feature_schema=model.FEATURE_SCHEMA,
                  label_schema=model.LABEL_SCHEMA, horizon_sessions=5, l3_identity={'id':'A'},
                  model=constant_model(), training_label_known_max='2026-08-01')
    bundle['model_checksum'] = model.digest(bundle['model'])
    model.validate_bundle(bundle,l3_identity={'id':'A'},signal_date='2026-08-02',require_paper_release=False)
    for identity, day, error in [({'id':'B'},'2026-08-02','version'),({'id':'A'},'2026-08-01','after_decision')]:
        with pytest.raises(ValueError,match=error):
            model.validate_bundle(bundle,l3_identity=identity,signal_date=day,require_paper_release=False)
    with pytest.raises(ValueError,match='release_missing'):
        model.validate_bundle(bundle,l3_identity={'id':'A'},signal_date='2026-08-02')
    bundle['model']['heads']['gain']['intercept'] = 9
    with pytest.raises(ValueError,match='checksum'):
        model.validate_bundle(bundle,l3_identity={'id':'A'},signal_date='2026-08-02',require_paper_release=False)


def test_fit_fixture_purges_labels_and_keeps_separate_heads():
    rows=[]
    for d in range(20):
        day=date(2026,1,1)+timedelta(days=d)
        for i in range(4):
            rows.append({'date':str(day),'symbol':str(i),'features':features(.1+.2*i),
                         'gross_return': .01 if i%2 else -.02, 'label_known_date':str(day+timedelta(days=5)),
                         'l3_training_label_known_max':'2025-12-01', 'feature_schema':model.FEATURE_SCHEMA, 'prediction_kind':'oof','l3_identity':{'id':'A'}})
    candidate=model.fit_candidate(rows,l3_identity={'id':'A'},as_of='2026-02-01',
                                  validation_dates=[['2026-01-15','2026-01-16']],lambdas=(1.,10.))
    assert set(candidate['model']['heads']) == set(model.HEADS)
    assert candidate['release']['decision'] == 'CANDIDATE'
    poisoned=copy.deepcopy(rows);poisoned[0]['l3_training_label_known_max']='2026-01-02'
    with pytest.raises(ValueError,match='time_or_lineage'):
        model.fit_candidate(poisoned,l3_identity={'id':'A'},as_of='2026-02-01',validation_dates=[['2026-01-15']])


def portfolio(mu, covariance=None, current=None, **kwargs):
    n=len(mu)
    params=dict(symbols=[str(i) for i in range(n)],expected_gross=mu,
                covariance=np.eye(n)*.05 if covariance is None else covariance,
                current_weights=[0.]*n if current is None else current,
                exposure_cap=.8,name_cap=.8,min_weight=.03,max_positions=None,
                buy_cost=.001,sell_cost=.004,time_limit=10.)
    params.update(kwargs)
    return allocate(**params)


def test_full_pool_cash_and_negative_ev_hedge():
    assert sum(portfolio([-.02,-.01])['weights'].values()) == pytest.approx(0)
    # A negative-EV asset can reduce total portfolio variance via covariance.
    q=np.array([[.1,-.09],[-.09,.1]])
    result=portfolio([.08,-.005],covariance=q,buy_cost=0.,sell_cost=0.)
    assert result['weights']['1'] > 0
    assert result['proof']['evaluated_candidate_count'] == 2
    assert result['proof']['preselection'] is False


def test_locked_positions_cash_and_discrete_limits():
    result=portfolio([.1,.09,.08],current=[.2,0,0],locked_symbols=['0'],
                     capital_available=.5,max_positions=2)
    assert result['weights']['0'] == pytest.approx(.2)
    assert sum(w>1e-7 for w in result['weights'].values())<=2
    assert sum(result['weights'].values())+result['expected_trading_cost']<=.5+1e-8
    assert result['proof']['within_tolerance']
    with pytest.raises(ValueError,match='requires_risk_exit'):
        portfolio([.1,.1],current=[.6,0],locked_symbols=['0'],exposure_cap=.5)


def test_execution_veto_does_not_force_whole_pool_empty():
    result=portfolio([.1,.08,.07],forbidden_buys=['0'])
    assert result['weights']['0']==pytest.approx(0)
    assert result['weights']['1']>0
    assert result['proof']['evaluated_candidate_count']==3
