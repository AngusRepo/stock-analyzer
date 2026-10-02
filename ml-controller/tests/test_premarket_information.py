from copy import deepcopy
import pytest
from services.premarket_information import build_information_delta

def record(key="sox", value=.01, observed="2026-10-01T05:00:00+08:00", version="v1"):
    return dict(source_key=key,version=version,session="2026-09-30-US",observed_at=observed,
                available_at=observed,payload={"return":value,"symbols":["2330","2303"]})

def base():
    return dict(signal_date="2026-10-01",available_at="2026-10-01T22:00:00+08:00",
                l3_snapshot_id="frozen-l3",sources=[record()])

def run(current, **kwargs):
    return build_information_delta(baseline=base(),current_records=current,
        cutoff="2026-10-02T07:00:00+08:00",trade_date="2026-10-02",**kwargs)

def test_changed_session_not_stock_loop():
    current=record(value=-.03,observed="2026-10-02T05:00:00+08:00")
    current["session"]="2026-10-01-US"
    result=run([current,current])
    assert len(result["changes"])==1
    assert result["changes"][0]["baseline"]["payload"]["return"]==.01
    assert result["changes"][0]["current"]["payload"]["return"]==-.03
    assert not result["scores_modified"] and not result["training_dispatched"]

def test_refresh_not_new_news():
    current=record(observed="2026-10-02T06:00:00+08:00")
    assert run([current])["changes"]==[]
    assert run([current])["unchanged"]==["sox"]

def test_future_and_naive_rejected():
    with pytest.raises(ValueError,match="future_information"):
        run([record(observed="2026-10-02T08:00:00+08:00")])
    with pytest.raises(ValueError,match="timezone_required"):
        run([record(observed="2026-10-02T06:00:00")])

def test_missing_and_stale_are_not_neutral():
    with pytest.raises(ValueError,match="required_sources_missing"):
        run([],required_sources=["sox"])
    assert run([])["missing"]==["sox"]
    with pytest.raises(ValueError,match="source_stale"):
        run([record()],max_age_seconds={"sox":3600})

def test_conflicting_duplicate_and_nan_rejected():
    with pytest.raises(ValueError,match="conflicting_source"):
        run([record(),record(value=.03)])
    with pytest.raises(ValueError):
        run([record(value=float("nan"))])

def test_baseline_not_mutated_and_deterministic():
    baseline=base(); saved=deepcopy(baseline)
    args=dict(baseline=baseline,current_records=[record()],cutoff="2026-10-02T07:00:00+08:00",trade_date="2026-10-02")
    assert build_information_delta(**args)==build_information_delta(**args)
    assert baseline==saved

def test_payload_is_detached_and_age_limit_must_be_finite():
    current=record(value=.02)
    result=run([current])
    current["payload"]["return"]=999
    assert result["changes"][0]["current"]["payload"]["return"]==.02
    with pytest.raises(ValueError,match="source_stale"):
        run([record()],max_age_seconds={"sox":float("nan")})
    with pytest.raises(ValueError,match="cutoff_trade_date_mismatch"):
        build_information_delta(baseline=base(),current_records=[],cutoff="2026-10-01T23:00:00+08:00",trade_date="2026-10-02")
