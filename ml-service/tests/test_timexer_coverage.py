import pytest
from app.timexer_coverage import validate_market_coverage

def test_missing_otc_is_not_hidden_by_complete_listed_market():
    expected={'2026-07-03':{'LISTED':100,'OTC':80}}
    rows=[{'market':'LISTED','date':'2026-07-03'} for _ in range(100)]
    with pytest.raises(ValueError,match='source_market_coverage_incomplete'):
        validate_market_coverage(rows,expected,{'2026-07-03'})

def test_eligibility_keeps_existing_eighty_percent_floor_and_exact_dates():
    expected={'2026-07-03':{'LISTED':100,'OTC':80},'2026-07-06':{'LISTED':1000}}
    rows=[{'market':m,'date':'2026-07-03'} for m,n in [('LISTED',80),('OTC',64)] for _ in range(n)]
    report=validate_market_coverage(rows,expected,{'2026-07-03'})
    assert report['OTC']['coverage']==.8 and report['LISTED']['coverage']==.8
    rows.pop()
    with pytest.raises(ValueError,match='incomplete'):validate_market_coverage(rows,expected,{'2026-07-03'})

def test_missing_expected_panel_fails_closed():
    with pytest.raises(ValueError,match='expected_market_panel_missing'):validate_market_coverage([],{},set())


def test_training_rejects_market_gap_before_constructing_any_model(monkeypatch):
    from app import timexer_training as training
    from app.timexer_contract import ARCHITECTURE, OFFICIAL_COMMIT
    monkeypatch.setattr(training, 'load_windows', lambda *_: ([], [
        {'date':'2026-07-03','market':'LISTED','label_known_date':'2026-07-10'}], {}))
    monkeypatch.setattr(training, 'official_model', lambda *_: pytest.fail('model built before preflight'))
    job={'settings':{**ARCHITECTURE,**training.TRAINING_SETTINGS,'official_commit':OFFICIAL_COMMIT},
         'exogenous':False,'train_start':'2026-01-01','train_end':'2026-07-02',
         'test_start':'2026-07-03','test_end':'2026-07-03',
         'expected_market_dates':{'2026-07-03':{'LISTED':1,'OTC':100}}}
    with pytest.raises(ValueError,match='source_market_coverage_incomplete'):
        training.train(job,None,device='cpu')
