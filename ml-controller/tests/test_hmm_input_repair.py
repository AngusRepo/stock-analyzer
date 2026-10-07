from datetime import date,timedelta
import copy
import pytest
from services.hmm_market_inputs import build_hmm_market_env
from services.hmm_input_contract import SOURCE,CONTRACT_HASH,checksum,validate_environment
from services.twse_margin_contract import parse_margin_summary

def data():
    days=[(date(2026,6,1)+timedelta(days=i)).isoformat() for i in range(50)]
    prices=[{"date":d,"close":30000+i*10,"source":SOURCE} for i,d in enumerate(days)]
    risks=[{"date":d,"risk_score":0,"quality_status":"complete","quality_version":"market-risk-quality-v1","quality_checksum":"a"*64} for d in days]
    return days,prices,risks

def test_single_index_units_zero_and_true_three_session_volatility():
    days,prices,risks=data()
    env=build_hmm_market_env(days[-1],prices,risks)
    row=env["history"][days[-1]]
    assert row["risk_score"]==0
    assert 0<row["market_bias_20d"]<.01
    assert row["market_return_5d"]==pytest.approx(prices[-1]["close"]/prices[-6]["close"]-1)
    assert env["market_return_1d"]==row["market_return_1d"]
    assert "bull_alignment_pct" not in row
    validate_environment(env)

@pytest.mark.parametrize("mutation",["cross_source","future","duplicate_conflict","stale","missing_latest_quality","gap"])
def test_bad_inputs_cannot_be_silently_imputed(mutation):
    days,prices,risks=data()
    if mutation=="cross_source":prices[-1]["source"]="0050"
    if mutation=="future":prices.append({**prices[-1],"date":"2026-12-01"})
    if mutation=="duplicate_conflict":prices.append({**prices[-1],"close":999})
    if mutation=="stale":prices.pop()
    if mutation=="missing_latest_quality":risks[-1]["quality_status"]="blocked"
    if mutation=="gap":risks[-10]["quality_status"]="blocked"
    with pytest.raises(ValueError):build_hmm_market_env(days[-1],prices,risks)

def test_contract_does_not_accept_changed_or_percentage_input():
    days,prices,risks=data();env=build_hmm_market_env(days[-1],prices,risks)
    env["history"][days[-1]]["market_bias_20d"]=4.99
    with pytest.raises(ValueError,match="CHECKSUM"):validate_environment(env)
    env["hmm_input_checksum"]=checksum(env["history"])
    with pytest.raises(ValueError,match="FRACTION"):validate_environment(env)

def test_margin_pairs_current_balance_with_previous_session_limit():
    def body(day,rows):return {"stat":"OK","date":day,"tables":[{"fields":["代號","名稱","買進","賣出","償還","前日餘額","今日餘額","次一營業日限額"],"data":rows}]}
    current=body("20261006",[["2330","A",0,0,0,20,"1,000",999999],["2317","B",0,0,0,20,0,999999]])
    prior=body("20261005",[["2330","A",0,0,0,20,0,"2,000"],["2317","B",0,0,0,20,0,1000]])
    parsed=parse_margin_summary(current,"2026-10-06",prior,"2026-10-05")
    assert parsed["balance"]==1000 and parsed["limit"]==3000 and parsed["coverage"]==2
    assert parse_margin_summary(current,"2026-10-06")["limit"] is None,"same-day next-session limit forbidden"
    assert parse_margin_summary(current,"2026-10-05",prior,"2026-10-04")["limit"] is None
    prior["tables"][0]["data"][1][7]="--"
    assert parse_margin_summary(current,"2026-10-06",prior,"2026-10-05")["limit"] is None

def test_new_listing_missing_prior_limit_preserves_risk_bounds():
    def body(day,rows):return {"stat":"OK","date":day,"tables":[{"fields":["代號","名稱","買進","賣出","償還","前日餘額","今日餘額","次一營業日限額"],"data":rows}]}
    current=body("20261006",[["2330","A",0,0,0,0,100,9999],["7822","New",0,0,0,0,0,8888]])
    prior=body("20261005",[["2330","A",0,0,0,0,90,1000]])
    parsed=parse_margin_summary(current,"2026-10-06",prior,"2026-10-05")
    assert parsed["status"]=="bounded" and parsed["limit"] is None
    assert parsed["ratio_lower"]==0 and parsed["ratio_upper"]==10
    assert parsed["unknown_limit_symbols"]==["7822"]

def test_container_contract_copies_are_identical():
    from pathlib import Path
    root=Path(__file__).parents[2]
    assert (root/'ml-controller/services/hmm_input_contract.py').read_bytes()==(root/'ml-service/app/hmm_input_contract.py').read_bytes()

def test_proven_equal_score_bounds_can_be_used_without_claiming_raw_completeness():
    days,prices,risks=data()
    for r in risks:r.update(quality_status="bounded",quality_known_score=0,quality_upper_score=0)
    env=build_hmm_market_env(days[-1],prices,risks)
    assert env["history"][days[-1]]["risk_input_quality"]=="bounded"
    risks[-1]["quality_upper_score"]=10
    with pytest.raises(ValueError):build_hmm_market_env(days[-1],prices,risks)

def test_training_preparation_defaults_to_no_fit_and_refuses_missing_approval(tmp_path):
    import json,subprocess,sys
    from pathlib import Path
    days,prices,risks=data();env=build_hmm_market_env(days[-1],prices,risks)
    path=tmp_path/'input.json';path.write_text(json.dumps(env),encoding='utf-8')
    tool=Path(__file__).parents[2]/'tools/prepare_hmm_training.py'
    cmd=[sys.executable,'-B',str(tool),'--input',str(path),'--output',str(tmp_path/'prepared')]
    result=subprocess.run(cmd,capture_output=True,text=True)
    assert result.returncode==0,result.stderr
    receipt=json.loads((tmp_path/'prepared/receipt.json').read_text())
    assert receipt['training_calls']==0 and receipt['history_days']==31
    assert not (tmp_path/'prepared/hmm_detector.joblib').exists()
    result=subprocess.run(cmd+['--execute'],capture_output=True,text=True)
    assert result.returncode!=0 and 'approval' in result.stderr
